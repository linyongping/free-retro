// Permission decisions. Everything that authorises a request lives here, so the
// expressions in docs/permission-matrix.md §9 have exactly one implementation.
//
// Two rules run through all of it:
//   * ownership does not grant access — every write guard is conjoined with
//     `canRead` (docs §1.1)
//   * board-level management requires still being on the team — `created_by`
//     alone is not enough, or a member removed from a team keeps control of the
//     board they created, including the power to flip it public

import { HttpError } from "./util.js";

export const isPublicBoard = (board) => board.visibility !== "team";

export async function loadBoard(env, boardId) {
  return await env.DB.prepare(
    "SELECT id, title, created_at, team_id, created_by, visibility, timer_ends_at, deleted_at FROM boards WHERE id = ?"
  )
    .bind(boardId)
    .first();
}

// Returns null when the board does not exist. Never throws — callers decide
// whether that is a 404 or a pass.
export async function boardAccess(env, me, boardId) {
  const board = await loadBoard(env, boardId);
  if (!board) return null;

  const member = me?.userId
    ? await env.DB.prepare("SELECT role, added_at FROM team_members WHERE team_id = ? AND user_id = ?")
        .bind(board.team_id, me.userId)
        .first()
    : null;

  const isTeamAdmin = member?.role === "admin";
  const isBoardCreator = !!me?.userId && board.created_by === me.userId;
  // `!== 'team'` rather than `=== 'public'`: a board created while the migration
  // and the deploy overlapped can still be NULL, and NULL must read as public.
  const canRead = isPublicBoard(board) || !!member;
  // the second half is the one that matters: created_by without current
  // membership must not keep managing the board
  const managesBoard = !!member && isBoardCreator;

  // A note belongs to whoever signed it. Legacy rows (owner_id NULL) deliberately
  // match nobody: on a public board "anyone may edit" would mean "anyone may
  // delete".
  //
  // The identity is a parameter rather than a capture: a first write mints an
  // anonymous session *after* this object was built, and the note that write just
  // created belongs to that brand-new identity.
  const ownsNote = (note, identity) => !!note.owner_id && note.owner_id === identity;
  const canEditNote = (note, identity = me?.identity) => canRead && (isTeamAdmin || ownsNote(note, identity));

  return {
    board,
    member,
    isTeamAdmin,
    isBoardCreator,
    managesBoard,
    canRead,
    // a soft-deleted board is hidden from everyone except the admins who have to
    // decide whether to restore it
    canView: canRead && (!board.deleted_at || isTeamAdmin),
    canWriteNote: canRead,
    canEditNote,
    canDeleteNote: canEditNote,
    canMoveNote: canRead,               // rule 16: same tier as adding a note
    canVote: canRead,                   // rules 12 + 17, subject = me.identity
    canRename: isTeamAdmin || managesBoard,
    canDelete: isTeamAdmin || managesBoard,        // soft delete, recoverable
    canPurge: isTeamAdmin,                         // unrecoverable
    canRestore: isTeamAdmin,                       // rule 10
    canMerge: managesBoard,                        // rule 8: board owner only, not TADMIN
    canSetVisibility: isTeamAdmin || managesBoard,
    canControlTimer: isTeamAdmin || managesBoard,
    // capabilities to hand the client; the server still re-checks every write
    noteFlags: (note, identity = me?.identity) => ({
      mine: note.owner_id === identity ? 1 : 0,
      can_edit: canEditNote(note, identity) ? 1 : 0,
      can_delete: canEditNote(note, identity) ? 1 : 0,
      can_move: canRead ? 1 : 0,
    }),
    boardFlags: {
      can_rename: isTeamAdmin || managesBoard ? 1 : 0,
      can_delete: isTeamAdmin || managesBoard ? 1 : 0,
      can_purge: isTeamAdmin ? 1 : 0,
      can_restore: isTeamAdmin ? 1 : 0,
      can_merge: managesBoard ? 1 : 0,
      can_set_visibility: isTeamAdmin || managesBoard ? 1 : 0,
      can_control_timer: isTeamAdmin || managesBoard ? 1 : 0,
      can_write_note: canRead ? 1 : 0,
      can_vote: canRead ? 1 : 0,
      visibility: board.visibility,
      is_team_admin: isTeamAdmin ? 1 : 0,
      is_board_owner: isBoardCreator ? 1 : 0,
    },
  };
}

export async function teamAccess(env, me, teamId) {
  const team = await env.DB.prepare("SELECT id, name, created_at, created_by FROM teams WHERE id = ?").bind(teamId).first();
  if (!team) return null;

  const member = me?.userId
    ? await env.DB.prepare("SELECT role, added_at FROM team_members WHERE team_id = ? AND user_id = ?")
        .bind(teamId, me.userId)
        .first()
    : null;

  const isTeamAdmin = member?.role === "admin";
  return {
    team,
    member,
    isTeamAdmin,
    // a team is invisible to non-members, so anything they may not see is a 404
    canView: !!member,
    canRename: isTeamAdmin,
    canDelete: isTeamAdmin,
    canAddMember: isTeamAdmin,
    canRemoveMember: isTeamAdmin,
    canGrantAdmin: isTeamAdmin,
    canRevokeAdmin: isTeamAdmin,
    canExport: isTeamAdmin,              // rule 15
    canListTrash: isTeamAdmin,
  };
}

// ------------------------------------------------------------------- guards

// Order matters: existence and read access are settled before anything else, so a
// denied reader learns nothing about what else the resource allows (docs §2).
export function requireBoard(access) {
  if (!access || !access.canRead) throw new HttpError(404, "board_not_found");
  return access;
}

export function requireTeam(access) {
  if (!access || !access.canView) throw new HttpError(404, "team_not_found");
  return access;
}

export function require(capability, error) {
  if (!capability) throw new HttpError(403, error || "forbidden");
}

export function requireSignedIn(me) {
  if (!me?.userId) throw new HttpError(401, "unauthorized");
  return me;
}

// "Cannot remove / cannot revoke / cannot leave" are three exits of one
// constraint. Without any one of them a team can lose its last admin, and with no
// global admin and no ownership transfer there is no way back.
export async function assertNotLastAdmin(env, teamId, userId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS admins FROM team_members WHERE team_id = ? AND role = 'admin' AND user_id != ?"
  )
    .bind(teamId, userId)
    .first();
  if (!row || row.admins === 0) {
    throw new HttpError(409, "last_admin", { hint: "assign another admin first" });
  }
}
