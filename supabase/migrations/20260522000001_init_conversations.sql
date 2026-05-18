-- Conversations: per-user threads of agent turns with persisted RunState for
-- HITL restart-safety and a rolling summary so long threads stay within the
-- model context budget on replay.

create table conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  summary text,
  summary_through_seq integer,
  status text not null default 'active'
    check (status in ('active','awaiting_approval','archived')),
  pending_state text,
  pending_approvals jsonb,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_sidebar_idx
  on conversations (organization_id, user_id, last_message_at desc);

create trigger conversations_updated_at
before update on conversations
for each row execute function set_updated_at();

alter table conversations enable row level security;

create policy conversations_select on conversations
for select to authenticated
using (is_org_member(organization_id) and user_id = (select auth.uid()));

create policy conversations_insert on conversations
for insert to authenticated
with check (is_org_member(organization_id) and user_id = (select auth.uid()));

create policy conversations_update on conversations
for update to authenticated
using (is_org_member(organization_id) and user_id = (select auth.uid()))
with check (is_org_member(organization_id) and user_id = (select auth.uid()));

-- No client delete this slice; archive via status.

create table conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  seq integer not null,
  role text not null check (role in ('user','assistant','system','tool')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (conversation_id, seq)
);

create index conversation_messages_conv_seq_idx
  on conversation_messages (conversation_id, seq);

-- Per-conversation monotonic seq. Assign in before-insert trigger so callers
-- can omit `seq`. Concurrent inserts on the same conversation_id may collide
-- on the unique (conversation_id, seq) index; agent persistence is single
-- writer per conversation so we don't lock here.
create or replace function conversation_messages_assign_seq()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.seq is null then
    select coalesce(max(seq), 0) + 1
      into new.seq
      from conversation_messages
      where conversation_id = new.conversation_id;
  end if;
  return new;
end;
$$;

create trigger conversation_messages_assign_seq_trg
before insert on conversation_messages
for each row execute function conversation_messages_assign_seq();

alter table conversation_messages enable row level security;

create policy conversation_messages_select on conversation_messages
for select to authenticated
using (
  exists (
    select 1 from conversations c
    where c.id = conversation_messages.conversation_id
      and is_org_member(c.organization_id)
      and c.user_id = (select auth.uid())
  )
);

create policy conversation_messages_insert on conversation_messages
for insert to authenticated
with check (
  exists (
    select 1 from conversations c
    where c.id = conversation_messages.conversation_id
      and is_org_member(c.organization_id)
      and c.user_id = (select auth.uid())
  )
);
