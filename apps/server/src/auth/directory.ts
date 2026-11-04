import { findUser, type User } from '../db/users.js';
import { roomAccess, type RoomAccess } from '../db/rooms.js';
import type { Db } from '../db/pool.js';
import type { Tokens } from './tokens.js';

/** What signaling needs from identity and durable rooms: Postgres in production, a Map in tests. */
export interface Directory {
  /** The user behind a valid access token, or undefined. Throws UNAVAILABLE (database down). */
  authenticate(accessToken: string): Promise<User | undefined>;
  /** The room as `userId` sees it, or undefined. Throws UNAVAILABLE (database down). */
  room(roomId: string, userId: string): Promise<RoomAccess | undefined>;
}

export function postgresDirectory(db: Db, tokens: Tokens): Directory {
  return {
    async authenticate(accessToken) {
      const userId = await tokens.verify(accessToken);
      return userId === undefined ? undefined : findUser(db, userId);
    },
    room: (roomId, userId) => roomAccess(db, roomId, userId),
  };
}

/** No directory configured: nobody can sign in. */
export const closedDirectory: Directory = {
  authenticate: () => Promise.resolve(undefined),
  room: () => Promise.resolve(undefined),
};
