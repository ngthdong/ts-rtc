import { query, type Db } from './pool.js';

export interface User {
  id: string;
  displayName: string;
}

const COLUMNS = 'id, email, display_name as "displayName"';

/** null: the address is taken (the unique index decides, so concurrent sign-ups are safe). */
export async function createUser(
  db: Db,
  user: { email: string; displayName: string; passwordHash: string },
): Promise<(User & { email: string }) | null> {
  const rows = await query<User & { email: string }>(
    db,
    `insert into users (email, display_name, password_hash) values ($1, $2, $3)
     on conflict (lower(email)) do nothing returning ${COLUMNS}`,
    [user.email, user.displayName, user.passwordHash],
  );
  return rows[0] ?? null;
}

export async function findUserByEmail(db: Db, email: string) {
  const rows = await query<User & { passwordHash: string }>(
    db,
    `select ${COLUMNS}, password_hash as "passwordHash" from users where lower(email) = lower($1)`,
    [email],
  );
  return rows[0];
}

export async function findUser(db: Db, id: string): Promise<User | undefined> {
  const rows = await query<User>(db, `select ${COLUMNS} from users where id = $1`, [id]);
  return rows[0];
}
