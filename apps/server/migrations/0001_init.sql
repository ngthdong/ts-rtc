-- Durable data only: accounts, rooms, who may join a private room. Live state stays in memory.
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null check (length(email) <= 254),
  password_hash text not null,
  display_name text not null check (length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);
-- One account per address, whatever its case; the index also decides registration races.
create unique index users_email_key on users (lower(email));

create table rooms (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  visibility text not null check (visibility in ('public', 'private')),
  mode text not null default 'sfu' check (mode in ('mesh', 'sfu')),
  max_participants int not null check (max_participants between 2 and 10),
  created_at timestamptz not null default now()
);
create index rooms_owner_idx on rooms (owner_id);

create table room_members (
  room_id uuid not null references rooms (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index room_members_user_idx on room_members (user_id);
