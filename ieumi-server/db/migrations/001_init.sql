-- 001_init — multi-tenant foundation (PROJECT.md §3-1, §3-3)
-- Every tenant-owned row carries center_id. Master rows are the ones with center_id IS NULL.

-- ============================================================
-- centers — the tenant
-- ============================================================
CREATE TABLE IF NOT EXISTS centers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text        NOT NULL UNIQUE,           -- 'seocho' — used in URLs
  name         text        NOT NULL,                  -- 서초 어르신 행복이음 센터
  region       text,                                  -- 서울 서초구
  kiosk_token  text        NOT NULL UNIQUE,           -- lets a kiosk identify its center without a login
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- users — three tiers (§3-3). master has no center; the other two always do.
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id     uuid        REFERENCES centers(id) ON DELETE CASCADE,
  role          text        NOT NULL CHECK (role IN ('master', 'center_admin', 'staff')),
  username      text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  name          text        NOT NULL DEFAULT '',
  active        boolean     NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_center_scope CHECK (
    (role = 'master' AND center_id IS NULL) OR
    (role <> 'master' AND center_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS users_center_idx ON users (center_id);

-- ============================================================
-- sessions — server-side sessions; id is sha256(token), never the token itself,
-- so a database leak does not hand over live sessions.
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id         text PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- ============================================================
-- members — the senior roster, per center (§3-4)
-- ============================================================
CREATE TABLE IF NOT EXISTS members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id  uuid        NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
  name       text        NOT NULL DEFAULT '',
  phone      text        NOT NULL,                    -- digits only
  note       text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (center_id, phone)
);
CREATE INDEX IF NOT EXISTS members_center_idx ON members (center_id);

-- ============================================================
-- services — the content catalog (§3-2).
-- scope='common'  → nationwide, owned by master, inherited by every center
-- scope='center'  → belongs to one center only
-- ============================================================
CREATE TABLE IF NOT EXISTS services (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text        NOT NULL,                   -- stable key: 's1', 's2', …
  scope       text        NOT NULL CHECK (scope IN ('common', 'center')),
  center_id   uuid        REFERENCES centers(id) ON DELETE CASCADE,
  category    text        NOT NULL,                   -- 건강 및 의료 / 복지 혜택 및 지원금 / …
  sub         text        NOT NULL DEFAULT '',
  description text        NOT NULL DEFAULT '',
  keywords    text        NOT NULL DEFAULT '',
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT services_scope_center CHECK (
    (scope = 'common' AND center_id IS NULL) OR
    (scope = 'center' AND center_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS services_common_code_idx ON services (code)            WHERE scope = 'common';
CREATE UNIQUE INDEX IF NOT EXISTS services_center_code_idx ON services (center_id, code) WHERE scope = 'center';
CREATE INDEX        IF NOT EXISTS services_center_idx      ON services (center_id);

-- ============================================================
-- center_services — a center's selection, ordering and overrides on top of the
-- inherited catalog. The absence of a row means "inherited, not yet enabled".
-- ============================================================
CREATE TABLE IF NOT EXISTS center_services (
  center_id            uuid        NOT NULL REFERENCES centers(id)  ON DELETE CASCADE,
  service_id           uuid        NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  enabled              boolean     NOT NULL DEFAULT false,
  sort_order           integer     NOT NULL DEFAULT 0,
  override_sub         text,                          -- NULL = inherit from services
  override_description text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (center_id, service_id)
);
CREATE INDEX IF NOT EXISTS center_services_order_idx ON center_services (center_id, sort_order);

-- ============================================================
-- center_settings — per-center Ieumi customization (§3-5)
-- ============================================================
CREATE TABLE IF NOT EXISTS center_settings (
  center_id       uuid PRIMARY KEY REFERENCES centers(id) ON DELETE CASCADE,
  ieumi_name      text        NOT NULL DEFAULT '이음이',
  voice_speaker   text        NOT NULL DEFAULT 'nara',   -- CLOVA speaker id
  voice_speed     text        NOT NULL DEFAULT '1',      -- 0 = normal, positive = slower
  tone            text        NOT NULL DEFAULT 'warm' CHECK (tone IN ('warm', 'plain', 'cheerful')),
  greeting        text        NOT NULL DEFAULT '',
  roster_check_on boolean     NOT NULL DEFAULT false,    -- match callers against the roster
  chat_model      text,                                  -- NULL = server default
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- requests — kiosk call → AI summary → staff handling loop (§6-P2)
-- ============================================================
CREATE TABLE IF NOT EXISTS requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id    uuid        NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
  member_id    uuid        REFERENCES members(id) ON DELETE SET NULL,
  caller_name  text        NOT NULL DEFAULT '',
  caller_phone text        NOT NULL DEFAULT '',
  category     text        NOT NULL DEFAULT 'etc' CHECK (category IN ('job', 'health', 'welfare', 'urgent', 'etc')),
  summary      text        NOT NULL DEFAULT '',
  transcript   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  chips        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  urgent       boolean     NOT NULL DEFAULT false,
  followup     boolean     NOT NULL DEFAULT false,
  status       text        NOT NULL DEFAULT '접수' CHECK (status IN ('접수', '처리중', '완료')),
  memo         text        NOT NULL DEFAULT '',
  handled_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS requests_center_time_idx ON requests (center_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_status_idx      ON requests (center_id, status);

-- ============================================================
-- job_posts — job material entered by hand in the admin dashboard
-- ============================================================
CREATE TABLE IF NOT EXISTS job_posts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id  uuid        NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
  title      text        NOT NULL,
  kind       text        NOT NULL DEFAULT '텍스트' CHECK (kind IN ('텍스트', '링크', '파일')),
  ref        text        NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_posts_center_idx ON job_posts (center_id, created_at DESC);
