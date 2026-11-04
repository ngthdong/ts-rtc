import type { RoomMode } from '@ts-rtc/protocol';
import { query, type Db } from './pool.js';

export type Visibility = 'public' | 'private';

export interface RoomRecord {
  id: string;
  ownerId: string;
  name: string;
  visibility: Visibility;
  mode: RoomMode;
  maxParticipants: number;
}

/** A room as one user sees it: the metadata, and whether that user was added as a member. */
export type RoomAccess = RoomRecord & { isMember: boolean };

const COLUMNS = `r.id, r.owner_id as "ownerId", r.name, r.visibility, r.mode,
  r.max_participants as "maxParticipants"`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createRoom(
  db: Db,
  ownerId: string,
  room: Omit<RoomRecord, 'id' | 'ownerId'>,
): Promise<RoomRecord> {
  const rows = await query<RoomRecord>(
    db,
    `insert into rooms as r (owner_id, name, visibility, mode, max_participants)
     values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
    [ownerId, room.name, room.visibility, room.mode, room.maxParticipants],
  );
  return rows[0] as RoomRecord;
}

/** Public rooms, plus the private ones the user owns or was added to. */
export function listRooms(db: Db, userId: string): Promise<RoomRecord[]> {
  return query<RoomRecord>(
    db,
    `select ${COLUMNS} from rooms r
     where r.visibility = 'public' or r.owner_id = $1
        or exists (select 1 from room_members m where m.room_id = r.id and m.user_id = $1)
     order by r.created_at desc limit 100`,
    [userId],
  );
}

/** One query per join: membership changes apply to the next join, nothing is cached. */
export async function roomAccess(
  db: Db,
  roomId: string,
  userId: string,
): Promise<RoomAccess | undefined> {
  if (!UUID.test(roomId)) return undefined;
  const rows = await query<RoomAccess>(
    db,
    `select ${COLUMNS}, exists (select 1 from room_members m
       where m.room_id = r.id and m.user_id = $2) as "isMember"
     from rooms r where r.id = $1`,
    [roomId, userId],
  );
  return rows[0];
}

export async function deleteRoom(db: Db, roomId: string): Promise<void> {
  await query(db, 'delete from rooms where id = $1', [roomId]); // members cascade
}

/** Idempotent: adding a member twice is a no-op. */
export async function addMember(db: Db, roomId: string, userId: string): Promise<void> {
  await query(
    db,
    'insert into room_members (room_id, user_id) values ($1, $2) on conflict do nothing',
    [roomId, userId],
  );
}

export async function removeMember(db: Db, roomId: string, userId: string): Promise<void> {
  await query(db, 'delete from room_members where room_id = $1 and user_id = $2', [roomId, userId]);
}
