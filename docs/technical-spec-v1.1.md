# AI Daily News Digest

# Technical Specification — MVP v1.1 FINAL

**Status:** Final  
**Version:** v1.1  
**Source of Truth:** Product Specification v1.1  
**Implementation Target:** Claude Code

---

# 1. Technical Overview

AI Daily News Digest là một ứng dụng web cho một admin, có nhiệm vụ:

- Quản lý RSS Sources.
- Thu thập Articles.
- Deduplicate Articles.
- Gom Articles thành Events.
- Sinh Event Title và Summary bằng tiếng Việt.
- Tạo Daily Digest theo ngày lịch Asia/Tokyo.
- Gửi một Email lúc 07:00 JST.
- Theo dõi trạng thái collection, AI processing, Digest và Email delivery.

MVP sử dụng:

```text
React + TypeScript + Vite
        +
Node.js + TypeScript + Fastify
        +
PostgreSQL
        +
pg-boss
        +
pgvector
```

Kiến trúc:

> **Modular Monolith**

Không sử dụng microservices trong MVP.

---

# 2. Confirmed Architecture Decisions

| Thành phần | Quyết định |
|---|---|
| Frontend | React + TypeScript + Vite |
| Backend | Node.js + TypeScript + Fastify |
| Architecture | Modular Monolith |
| Database | PostgreSQL |
| Vector Search | pgvector |
| Background Jobs | PostgreSQL + pg-boss |
| Repository | pnpm monorepo |
| Authentication | Server-side session |
| Session Cookie | HttpOnly + Secure |
| Business Timezone | Asia/Tokyo |
| Digest Language | Vietnamese |
| Digest Time | 07:00 JST |
| Digest Frequency | Once per day |
| Source Collection | RSS-first |
| Website Crawling | Not MVP |
| AI | Provider abstraction |
| Email | Provider abstraction |

Domain/Application layer không được phụ thuộc trực tiếp vào SDK của AI provider hoặc Email provider.

---

# 3. Current Project Analysis

Frontend hiện tại là:

- React.
- TypeScript.
- Vite.
- Mock data.
- Mock interactions.
- Monolithic `App.tsx`.

UI hiện tại bao gồm:

```text
Dashboard
Sources
Add Source
Edit Source
Source Detail
News & Events
Event Detail
Settings
Email Preview
```

UI được xem là:

> **Visual and interaction reference**

không phải source of truth cho business logic.

Frontend phải được refactor dần, không rewrite toàn bộ.

Một màn hình Login cần được bổ sung để đáp ứng Authentication requirement.

---

# 4. System Architecture

```text
                         ┌───────────────────┐
                         │    RSS Sources    │
                         └─────────┬─────────┘
                                   │
                                   ▼
                         ┌───────────────────┐
                         │ Collector Worker  │
                         └─────────┬─────────┘
                                   │
                                   ▼
                         ┌───────────────────┐
                         │ PostgreSQL        │
                         │ + pg-boss         │
                         └─────────┬─────────┘
                                   │
                                   ▼
                         ┌───────────────────┐
                         │ AI Worker         │
                         │                   │
                         │ Normalize         │
                         │ Deduplicate       │
                         │ Candidate Match   │
                         │ Event Clustering  │
                         │ Vietnamese Summary│
                         └─────────┬─────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
             ┌──────────────┐              ┌──────────────┐
             │ Fastify API  │              │ Digest Worker│
             └──────┬───────┘              └──────┬───────┘
                    │                             │
                    ▼                             ▼
             ┌──────────────┐              ┌──────────────┐
             │ React Web    │              │ EmailProvider│
             └──────────────┘              └──────────────┘
```

API và Workers cùng nằm trong một backend codebase.

Có thể chạy API và Worker thành các process riêng nhưng không tạo microservices độc lập.

---

# 5. Tech Stack

## Frontend

```text
React
TypeScript
Vite
```

Không migrate sang Next.js.

## Backend

```text
Node.js
TypeScript
Fastify
```

## Database

```text
PostgreSQL
```

## Vector Search

```text
pgvector
```

Chỉ sử dụng khi cần cho Event candidate retrieval.

Không sử dụng vector database riêng.

## Queue

```text
pg-boss
```

Không sử dụng Redis trong MVP.

## Validation

Sử dụng runtime-validated schemas trong:

```text
packages/contracts
```

## Provider Abstraction

AI và Email phải được truy cập thông qua internal interfaces.

---

# 6. Project Structure

```text
AIDailyNewsDigest/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   ├── public/
│   │   ├── index.html
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vite.config.ts
│   │
│   └── server/
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
│
├── packages/
│   ├── contracts/
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── domain/
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
│
├── docs/
│   ├── product-spec-v1.1.md
│   └── technical-spec-v1.1.md
│
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── CLAUDE.md
└── AGENTS.md
```

---

# 7. Package Boundaries

```text
apps/web
    ↓
packages/contracts

apps/server
    ↓
packages/contracts
    ↓
packages/domain
```

`packages/domain` không phụ thuộc:

- React.
- Fastify.
- PostgreSQL.
- AI SDK.
- Email SDK.

`packages/contracts` phải framework-agnostic.

---

# 8. Authentication & User Model

MVP:

> **Public Web App + Single Admin User + Login**

Không có:

- Public registration.
- Social login.
- Multi-user.
- Roles.
- Workspace permissions.

---

## User

```text
users
```

Fields:

```text
id
email
password_hash
disabled_at
created_at
updated_at
```

Email unique.

Initial admin được provisioning thông qua secure operator command hoặc deployment procedure.

Không expose public account creation endpoint.

---

## Password

Sử dụng:

> Argon2id

Không lưu plaintext password.

---

## Session

```text
sessions
```

Fields:

```text
id
user_id
expires_at
last_seen_at
created_at
```

Session identifier phải cryptographically random.

Cookie:

```text
HttpOnly
Secure (production)
SameSite=Lax
Path phù hợp
```

Không lưu authentication token trong `localStorage`.

---

## Session Policy

- Idle expiration: 12 giờ.
- Absolute expiration: 7 ngày.
- Logout phải invalidate server-side session.
- Cookie phải được clear khi logout.
- Login phải rate-limited.
- State-changing requests phải có CSRF protection.

---

# 9. User Settings

```text
user_settings
```

Fields:

```text
user_id
recipient_email
timezone
send_local_time
created_at
updated_at
```

MVP:

```text
timezone = Asia/Tokyo
send_local_time = 07:00
```

Chỉ:

```text
recipient_email
```

có thể chỉnh sửa.

Timezone và Send Time là product-controlled constants.

---

# 10. Database Design

Tất cả timestamps lưu dưới dạng:

> UTC `timestamptz`

Digest business date lưu:

> PostgreSQL `date`

theo:

> `Asia/Tokyo`

Entities:

```text
users
sessions
user_settings
sources
articles
events
event_articles
daily_digests
digest_events
email_deliveries
outbox_events
processing_attempts
```

---

# 11. Source Model

```text
sources
```

Fields:

```text
id
user_id
name
website_url
rss_url
enabled
status
last_fetched_at
last_error_code
last_error_at
deleted_at
created_at
updated_at
```

### `website_url`

URL của website/publisher.

### `rss_url`

RSS/Atom feed URL.

Hai field này **không được gộp thành một `feed_url` duy nhất**.

---

## Source Status

```text
active
disabled
error
```

---

## Source Delete

Delete là soft delete:

```text
deleted_at != null
enabled = false
```

Không cascade delete:

- Articles.
- Events.
- Daily Digests.

Historical Articles vẫn giữ Source relationship.

Historical UI có thể hiển thị Source name đã được snapshot hoặc giữ nguyên reference tới Source archived.

Có thể restore Source bằng cách clear `deleted_at` và enable lại nếu phù hợp.

---

# 12. Article Model

```text
articles
```

Fields:

```text
id
source_id
external_id
canonical_url
original_url
original_title
original_language
original_excerpt
original_content
published_at
published_date_jst
discovered_at
processing_status
processing_error_code
late_arrival
missed_digest_cutoff
created_at
updated_at
```

`published_at` có thể nullable nếu Source không cung cấp timestamp đáng tin cậy.

Không sử dụng `discovered_at` làm `published_at`.

---

# 13. Article Normalization

Persist original source information:

- Original URL.
- Canonical URL.
- Original title.
- Original content/excerpt.
- Source.
- External GUID/ID.
- Original publication time.
- Discovery time.
- Detected language.

Normalize:

- Whitespace.
- Known feed encoding.
- Comparison fields.

Không overwrite original source content.

---

# 14. Article Deduplication

Deterministic precedence:

### 1. Canonical URL

Nếu cùng normalized canonical URL:

> Same Article.

Ngay cả khi GUID khác nhau.

### 2. Source External ID / GUID

Nếu cùng non-empty external ID từ cùng Source:

> Same Article.

### 3. Content Fingerprint

Chỉ dùng trong cùng Source và khi:

- normalized title match.
- meaningful content match.

Fingerprint không được tự động merge Articles từ các Source khác nhau.

---

## URL Normalization

- Lowercase scheme/host.
- Remove default ports.
- Remove fragment.
- Normalize safe path syntax.
- Chỉ remove tracking parameters nằm trong allowlist rõ ràng.
- Không tự động remove toàn bộ query parameters.

Không làm mất query parameter có thể xác định Article.

---

# 15. Event Model

```text
events
```

Fields:

```text
id
user_id
title_vi
summary_vi
status
first_seen_at
last_seen_at
processing_status
prompt_version
model
provider
created_at
updated_at
```

Event là real-world event.

Event không bị gắn cố định vào một calendar date.

---

# 16. Event ↔ Article

MVP:

> Một Article thuộc tối đa một Event.

Một Event có thể có nhiều Article.

```text
event_articles
```

Fields:

```text
event_id
article_id
association_method
created_at
```

Constraint:

```text
UNIQUE(article_id)
```

để database enforce:

> One Article → Maximum One Event.

---

# 17. Event ↔ Daily Digest

Một Event có thể xuất hiện trong nhiều Daily Digests.

Ví dụ:

```text
Event A
 ├── Digest 11/11
 └── Digest 12/11
```

Quan hệ:

```text
Event
  ↕
DigestEvent
  ↕
DailyDigest
```

là many-to-many.

---

# 18. Daily Digest Model

```text
daily_digests
```

Fields:

```text
id
user_id
local_date
status
built_at
sent_at
failure_code
created_at
updated_at
```

Constraint:

```text
UNIQUE(user_id, local_date)
```

Một User chỉ có một Daily Digest cho một ngày.

---

## Digest Status

```text
scheduled
building
ready
sending
sent
failed
```

Không cần status `empty`.

Empty Digest được biểu diễn bằng:

```text
status = ready
```

và:

```text
0 digest_events
```

Sau khi gửi:

```text
status = sent
```

---

# 19. DigestEvent

```text
digest_events
```

Fields:

```text
digest_id
event_id
position
title_vi_snapshot
summary_vi_snapshot
article_snapshot
source_snapshot
created_at
```

Constraints:

```text
PRIMARY KEY(digest_id, event_id)

UNIQUE(digest_id, position)
```

Snapshot phải chứa đủ thông tin để historical Digest có thể hiển thị độc lập với Event hiện tại.

Snapshot nên giữ:

- Event title.
- Event summary.
- Article IDs.
- Original Article titles.
- Original URLs.
- Source names.
- Source URLs nếu cần.

Persistence sử dụng hai cột `JSONB` riêng:

- `article_snapshot`: danh sách `{ articleId, sourceId, originalTitle, originalUrl }`.
- `source_snapshot`: danh sách `{ sourceId, name, websiteUrl, rssUrl }`.

Các snapshot là dữ liệu lịch sử độc lập; không đọc ngược từ Article hoặc Source hiện tại để render Digest đã gửi.

---

# 20. Digest Immutability

Khi:

```text
daily_digests.status = sent
```

Digest trở thành immutable.

Không được:

- Add Event.
- Remove Event.
- Change position.
- Change title snapshot.
- Change summary snapshot.
- Change Article snapshot.
- Regenerate email.
- Resend.

Event hiện tại vẫn có thể tiếp tục được cập nhật độc lập.

---

# 21. Daily Digest Date Rule

Canonical business timezone:

> `Asia/Tokyo`

Article date:

```text
published_at
    ↓
convert to Asia/Tokyo
    ↓
published_date_jst
```

Ví dụ:

```text
11/11 23:59 JST
→ Digest 11/11
```

```text
12/11 00:00 JST
→ Digest 12/11
```

Server timezone không được dùng để xác định business date.

---

# 22. Daily Digest Generation

Target Digest date:

> D

Digest được generate vào:

> D+1

Initial schedule:

```text
05:30 JST
Collection cutoff

06:00 JST
Digest generation

06:30 JST
Snapshot preparation

06:45 JST
Final validation / snapshot cutoff

07:00 JST
Email send
```

Exact schedule có thể cấu hình bằng deployment configuration.

Nhưng invariant phải giữ:

```text
Collection cutoff
    <
Digest generation
    <
Snapshot cutoff
    <
07:00 JST
```

---

# 23. Cutoff & Unfinished Processing Policy

MVP ưu tiên:

> **On-time delivery over complete coverage.**

Tại:

> **06:45 JST**

hệ thống freeze latest valid snapshot.

Nếu Article/AI processing chưa hoàn thành:

- Không chờ thêm.
- Không đưa Article đó vào Digest.
- Đánh dấu `missed_digest_cutoff`.
- Tiếp tục processing sau 07:00.
- Không gửi Email thứ hai.

---

## If Digest Generation Fails Completely

Nếu không tạo được valid snapshot trước deadline:

> Tạo và gửi một Empty Digest snapshot.

Ghi:

> degraded-generation error

và tạo operational alert.

Mục tiêu:

> Vẫn gửi một Email đúng 07:00 JST.

Không tạo một flow gửi lần hai.

---

# 24. Late-Arriving Articles

Late Article:

> Article được discovered sau ngày publish JST.

Ví dụ:

```text
published:
11/11 23:50 JST

discovered:
12/11 08:00 JST
```

Article:

- Được lưu.
- Được xử lý.
- `late_arrival = true`.
- Có thể được liên kết Event.
- Không thay đổi Digest 11.
- Không trigger Email thứ hai.

---

# 25. Missed Digest Cutoff

Missed Digest Cutoff:

> Article đã có trong hệ thống nhưng chưa hoàn tất processing trước 06:45 snapshot cutoff.

Đánh dấu:

```text
missed_digest_cutoff = true
```

Article vẫn được xử lý sau đó.

Không được đưa ngược vào Digest đã gửi.

Không trigger email thứ hai.

---

# 26. Event Across Multiple Days

Ví dụ:

```text
Event A

11/11
Article A
Article B
→ Digest 11

12/11
Article C
→ Digest 12
```

Event A là cùng một Event.

Không tạo Event duplicate chỉ vì calendar date thay đổi.

Digest membership dựa trên qualifying Articles của từng ngày.

---

# 27. AI Architecture

Pipeline:

```text
New Article
    ↓
Normalize
    ↓
Exact Duplicate
    ↓
Candidate Retrieval
    ↓
Embedding
    ↓
Semantic Similarity
    ↓
Entity / Time / Location Signals
    ↓
AI Judge
    ↓
Existing Event
OR
New Event
OR
Uncertain
    ↓
Vietnamese Summary
```

---

# 28. Candidate Retrieval

Candidate retrieval có thể sử dụng:

- Multilingual embeddings.
- `pgvector`.
- Publication time.
- Entities.
- Location.
- Topic.
- Existing Event metadata.

Initial candidate window:

> 72 hours

là configurable starting point, không phải universal rule.

Initial similarity threshold:

> **0.88 cosine similarity**

Threshold chỉ dùng để:

> Retrieve candidates.

Không được dùng similarity threshold một mình để quyết định merge.

---

# 29. Event Merge Policy

AI Judge phải trả structured result:

```text
merge
new_event
uncertain
```

### `merge`

Merge Article vào existing Event.

### `new_event`

Tạo Event mới.

### `uncertain`

Không merge tự động.

MVP behavior:

> Tạo/giữ Article như một Event riêng nếu cần.

Không xây dựng manual moderation workflow trong MVP.

Nguyên tắc:

> False merge nguy hiểm hơn duplicate Event.

---

# 30. Event Clustering Safety

Không tự động merge khi:

- Evidence yếu.
- Similarity thấp.
- Entity conflict.
- Time conflict lớn.
- Location conflict lớn.
- AI Judge trả uncertain.

Không hiển thị AI confidence cho User.

---

# 31. AI Provider Abstraction

Internal interface:

```ts
interface AIProvider {
  generateStructured(
    input: StructuredInput
  ): Promise<StructuredResult>;

  generateSummary(
    input: SummaryInput
  ): Promise<SummaryResult>;

  generateEmbedding(
    input: EmbeddingInput
  ): Promise<EmbeddingResult>;
}
```

Application/Domain không import vendor SDK trực tiếp.

Adapter chịu trách nhiệm:

- Authentication.
- Request formatting.
- Response parsing.
- Model selection.
- Timeout.
- Retry.
- Rate limiting.
- Usage.
- Cost.

---

# 32. AI Metadata

Track:

```text
provider
model
model_version
prompt_version
operation
latency
input_tokens
output_tokens
estimated_cost
status
error_code
```

Không log sensitive prompt data không cần thiết.

---

# 33. AI Structured Output

AI response phải validate bằng runtime schema.

Ví dụ Event summary:

```json
{
  "title": "...",
  "summary": "...",
  "language": "vi",
  "source_article_ids": ["..."]
}
```

Validation:

1. JSON/schema hợp lệ.
2. Article IDs tồn tại.
3. Article IDs thuộc đúng User.
4. Title không rỗng.
5. Summary không rỗng.
6. Summary bằng tiếng Việt.
7. Summary grounded trong source Articles.

Invalid output:

> Không được ghi đè valid data.

Retry có giới hạn.

---

# 34. Multilingual Processing

Input có thể:

```text
Vietnamese
Japanese
English
```

AI phải hỗ trợ cross-language clustering.

Ví dụ:

```text
VTV
"Bão X đổ bộ..."

NHK
"Typhoon X hits..."

CNN
"Storm X reaches..."
```

→ Một Event.

Event:

```text
Title:
Bão X đổ bộ...

Summary:
...
```

Original Article:

> Không dịch trong MVP.

Giữ nguyên:

- Original title.
- Original content.
- Source.
- URL.

---

# 35. AI Summarization

Summary:

- Tiếng Việt.
- 2–4 câu.
- Khoảng 60–100 Vietnamese words như initial target.
- Grounded.
- Không hallucinate.
- Không thêm facts không có trong nguồn.

Độ dài có thể được tuning qua AI evaluation nhưng:

> Output language = Vietnamese

không phải Open Question.

---

# 36. Background Jobs

Sử dụng:

> `pg-boss`

Jobs:

```text
collect-source
process-article
cluster-candidates
summarize-event
generate-digest
deliver-digest
reconcile-delivery
retry-failed
cleanup
```

Jobs là at-least-once.

Handler phải idempotent.

---

# 37. Job: collect-source

Input:

```text
source_id
```

Flow:

```text
Source
 ↓
Validate
 ↓
Safe Fetch
 ↓
Parse RSS
 ↓
Normalize
 ↓
Deduplicate
 ↓
Persist Article
 ↓
Enqueue process-article
```

Retry:

- Network error → retry.
- Rate limit → retry.
- Invalid RSS → bounded retry/mark error.
- Invalid URL → no endless retry.

---

# 38. Job: process-article

Input:

```text
article_id
```

Flow:

```text
Article
 ↓
Normalize
 ↓
Embedding
 ↓
Candidate Retrieval
 ↓
AI Judge
 ↓
Event association
 ↓
Summary
```

Không tạo duplicate Event association.

---

# 39. Job: generate-digest

Input:

```text
user_id
local_date
```

Flow:

```text
Select qualifying Articles
 ↓
Select Events
 ↓
Order Events
 ↓
Create Digest
 ↓
Create DigestEvent snapshots
 ↓
Validate
 ↓
Ready
```

Unique:

```text
UNIQUE(user_id, local_date)
```

Job có thể retry an toàn trước khi Digest sent.

---

# 40. Job: deliver-digest

Input:

```text
digest_id
```

Flow:

```text
Digest
 ↓
Create/reuse EmailDelivery
 ↓
Check status
 ↓
EmailProvider.send()
 ↓
accepted
 ↓
sent
```

Ambiguous timeout:

```text
unknown
 ↓
reconcile
```

Không retry mù quáng.

---

# 41. Email Provider

Interface:

```ts
interface EmailProvider {
  send(
    input: SendEmailInput
  ): Promise<SendEmailResult>;

  getDeliveryStatus(
    messageId: string
  ): Promise<DeliveryStatus>;
}
```

EmailDelivery fields:

```text
id
digest_id
provider
provider_message_id
idempotency_key
status
attempt_count
last_error_code
last_error_at
accepted_at
delivered_at
created_at
updated_at
```

---

# 42. Email Delivery Status

```text
pending
sending
accepted
delivered
failed
unknown
```

`accepted`:

> Provider accepted send request.

`delivered`:

> Provider confirmed delivery if supported.

`unknown`:

> Outcome cannot currently be determined.

---

# 43. Email Idempotency

Stable key:

```text
daily-digest:{user_id}:{local_date}
```

Database:

```text
UNIQUE(digest_id)
```

Provider idempotency key should use the same stable logical delivery identity where supported.

Không claim:

> Exactly-once delivery

unless provider guarantees it.

Application guarantee:

> No intentional duplicate send and no second Digest for the same date.

---

# 44. API Specification

Base:

```text
/api/v1
```

---

## Authentication

```text
POST /auth/login
POST /auth/logout
GET  /auth/session
```

### POST `/auth/login`

Request:

```json
{
  "email": "admin@example.com",
  "password": "..."
}
```

Response:

```json
{
  "user": {
    "id": "...",
    "email": "admin@example.com"
  }
}
```

Sets session cookie.

---

## Sources

```text
GET    /sources
POST   /sources
GET    /sources/:sourceId
PATCH  /sources/:sourceId
DELETE /sources/:sourceId
POST   /sources/:sourceId/retry
```

### Create Source

```json
{
  "name": "VnExpress",
  "websiteUrl": "https://vnexpress.net",
  "rssUrl": "https://example.com/rss",
  "enabled": true
}
```

`rssUrl` optional.

---

## Articles

```text
GET /articles
```

Query:

```text
page
pageSize
date
sourceId
status
```

---

## Events

```text
GET /events
GET /events/:eventId
POST /events/:eventId/retry
```

`GET /events` query:

```text
search
date
sourceId
page
pageSize
sort
```

MVP:

```text
search:
Event Title
Article Title
Source Name

date:
JST calendar date

sourceId:
Source ID

sort:
latest
```

Latest ordering:

> Latest relevant Article publication/update time first.

If publication time is unavailable:

> Use discovered time as ordering fallback only.

Stable ID tie-breaker must be used.

---

## Digest

```text
GET /digests
GET /digests/:digestId
GET /digests/:digestId/preview
```

Preview returns:

- Subject.
- Date.
- Events.
- Sources.
- Summary.
- Original Article links.
- `isEmpty`.

Preview does not send Email.

---

## Settings

```text
GET /settings
PATCH /settings
```

GET response:

```json
{
  "recipientEmail": "user@example.com",
  "timezone": "Asia/Tokyo",
  "sendLocalTime": "07:00"
}
```

PATCH only accepts:

```json
{
  "recipientEmail": "new@example.com"
}
```

Timezone and send time cannot be changed through API.

---

# 45. API Error Format

All API errors use:

```json
{
  "error": {
    "code": "SOURCE_NOT_FOUND",
    "message": "Source not found."
  }
}
```

Common codes:

```text
UNAUTHORIZED
FORBIDDEN
VALIDATION_ERROR
NOT_FOUND
CONFLICT
RATE_LIMITED
INTERNAL_ERROR
```

Never expose:

- Stack traces.
- SQL details.
- Provider secrets.
- Internal infrastructure details.

---

# 46. API Pagination

Collection APIs use:

```text
page
pageSize
```

Maximum:

```text
pageSize = 100
```

Response:

```json
{
  "items": [],
  "page": 1,
  "pageSize": 20,
  "total": 100
}
```

---

# 47. Frontend Architecture

Keep:

> React + TypeScript + Vite.

Refactor current monolithic `App.tsx` incrementally.

Suggested:

```text
apps/web/src/
├── app/
├── components/
├── features/
│   ├── auth/
│   ├── dashboard/
│   ├── sources/
│   ├── articles/
│   ├── events/
│   ├── digest/
│   └── settings/
├── lib/
├── routes/
└── main.tsx
```

Use URL-based routing.

Use a server-state solution such as:

> TanStack Query

or equivalent.

Do not use global state for server data unless necessary.

---

# 48. Frontend Routes

Required:

```text
/login

/
/sources
/sources/new
/sources/:id
/sources/:id/edit

/events
/events/:id

/settings

/digests/:id
```

Authenticated routes require valid session.

Expired session:

```text
→ redirect /login
```

---

# 49. Frontend API Contract

Screen mapping:

```text
Dashboard
→ GET /dashboard/summary

Sources
→ GET /sources

Add Source
→ POST /sources

Edit Source
→ PATCH /sources/:id

Delete Source
→ DELETE /sources/:id

Events
→ GET /events

Event Detail
→ GET /events/:id

Settings
→ GET /settings
→ PATCH /settings

Digest Preview
→ GET /digests/:id/preview
```

Frontend must not simulate successful server operations.

Example:

> Clicking Retry should show `queued` until backend returns success/failure.

---

# 50. Frontend UX States

Every API-driven screen must support:

- Loading.
- Empty.
- Error.
- Success.
- Disabled where applicable.

Source:

```text
Active
Disabled
Error
```

Digest:

```text
Not Generated
Generating
Ready
Sending
Sent
Failed
Empty Content
```

AI:

```text
Processing
Processed
Failed
```

---

# 51. Security

## SSRF

RSS URL is user-controlled.

Must:

- Allow supported HTTP(S).
- Reject URL credentials.
- Block private IP.
- Block loopback.
- Block link-local.
- Block multicast.
- Block reserved addresses.
- Block cloud metadata endpoints.
- Revalidate redirect destinations.
- Protect against DNS rebinding.
- Limit redirects.
- Limit response size.
- Timeout connections.

Do not forward:

- Cookies.
- Authorization headers.
- Credentials.

---

## Feed HTML

Feed content is untrusted.

Before rendering:

> Sanitize HTML.

Never render raw feed HTML directly.

---

## Database

Use:

> Parameterized queries / ORM parameters.

No SQL string concatenation with user input.

---

## API Rate Limits

At minimum rate-limit:

- Login.
- Source creation.
- Source update.
- Retry endpoints.

---

## Secrets

Never expose to frontend:

- AI API keys.
- Email API keys.
- Database credentials.
- Session secrets.
- Webhook secrets.

---

# 52. Observability

Structured logs should include where appropriate:

```text
request_id
job_id
user_id
source_id
article_id
event_id
digest_id
email_delivery_id
```

Never log:

- Passwords.
- Session cookies.
- API secrets.
- Sensitive provider payloads.

---

# 53. Metrics

Track:

### Collection

- Success/failure.
- Duration.
- Last success.
- Article count.
- Duplicate count.
- Late Articles.
- Missed-cutoff Articles.

### AI

- Latency.
- Failure.
- Retry.
- Model.
- Prompt version.
- Usage.
- Cost.

### Digest

- Build status.
- Snapshot time.
- Ready time.
- Send time.

### Email

- Accepted.
- Delivered.
- Failed.
- Unknown.
- Reconciliation duration.

### Queue

- Queue depth.
- Oldest pending job.
- Exhausted retries.

---

# 54. Health & Readiness

API:

```text
GET /health
GET /ready
```

Worker phải có health/readiness mechanism phù hợp.

Alert khi:

- Daily Digest chưa Ready đúng thời hạn.
- Email chưa gửi đúng 07:00.
- Job bị stuck.
- Queue backlog tăng bất thường.
- Email status unknown quá lâu.
- Source failure lặp lại.
- AI failure lặp lại.

---

# 55. Testing Strategy

## Unit Tests

Test:

- JST date conversion.
- Midnight boundary.
- Digest date.
- Cutoff.
- Late Article.
- Missed cutoff.
- Dedup precedence.
- URL normalization.
- Event association.
- Digest snapshot.
- Idempotency.
- Email state transitions.

---

## Integration Tests

Test:

- PostgreSQL.
- Foreign keys.
- Unique constraints.
- Transactions.
- Migrations.
- pg-boss.
- Transactional outbox.
- Source soft delete.
- Historical data preservation.

---

## API Tests

Test:

- Authentication.
- Authorization.
- Validation.
- Pagination.
- Search.
- Date filter.
- Source filter.
- Sorting.
- Error responses.
- CSRF.
- Rate limits.

---

## Frontend Tests

Test:

- Login.
- Route guards.
- Source CRUD.
- Delete confirmation.
- Search.
- Filters.
- Event detail.
- Settings.
- Digest preview.
- Loading.
- Error.
- Empty states.
- Session expiration.

---

# 56. AI Evaluation

Create a versioned offline dataset containing:

### Same Event

```text
Vietnamese ↔ Vietnamese
Vietnamese ↔ Japanese
Vietnamese ↔ English
Japanese ↔ English
```

### Different Events

Articles with similar topics but different real-world events.

### Exact Duplicates

Same URL/content.

### Near Duplicates

Different URLs, almost same content.

### Summary Examples

Reference examples for factuality and Vietnamese quality.

Metrics:

- False merge rate.
- Missed merge rate.
- Duplicate Event rate.
- Cross-language clustering.
- Summary factual support.
- Hallucination rate.
- Invalid structured output.
- Latency.
- Cost.

---

# 57. Deployment

Environments:

```text
Development
Staging
Production
```

Production components:

```text
Web
API
Worker
PostgreSQL
AI Provider
Email Provider
```

Web/API/Worker có thể deploy từ cùng monorepo.

Worker có thể chạy process riêng.

---

# 58. Production Configuration

Environment-specific:

- Database URL.
- Session secret.
- AI provider credentials.
- Email provider credentials.
- Webhook secrets.
- Allowed frontend origin.
- Job configuration.
- Timeouts.
- Rate limits.

Secrets không commit vào Git.

---

# 59. Database Migrations

Migrations phải:

- Versioned.
- Reproducible.
- Executed as controlled deployment step.
- Tested in staging.
- Backward compatible where needed.

Không thay đổi production schema thủ công.

---

# 60. Backup & Restore

PostgreSQL phải có:

- Automated backups.
- Restore procedure.
- Restore testing.

Initial operational target:

```text
RPO ≤ 24 hours
RTO ≤ 4 hours
```

Đây là operational target, không phải SLA.

---

# 61. Data Retention

Preserve:

- Historical Articles.
- Historical Events.
- Daily Digest snapshots.
- Email Delivery history.

Source deletion không xóa historical data.

Transient operational data có thể cleanup theo policy.

Không cleanup dữ liệu được Digest còn tham chiếu.

Raw Article content retention phải được cấu hình trước Production theo policy phù hợp.

---

# 62. Performance

Initial targets:

```text
Dashboard API p95 < 500ms
Sources API p95 < 500ms
Events API p95 < 700ms
CRUD API p95 < 500ms
```

Các target này là mục tiêu MVP, không phải SLA.

AI processing và RSS collection không được block Web API requests.

Digest phải Ready trước 07:00 trong điều kiện vận hành bình thường.

---

# 63. Scalability

MVP:

> Single User.

Initial target:

> Approximately 100 Sources.

Không cần microservices.

Các phần có thể scale độc lập khi cần:

```text
Collector Workers
AI Workers
Email Workers
```

PostgreSQL vẫn là source of truth.

Không thêm Redis hoặc separate vector database nếu chưa có nhu cầu thực tế.

---

# 64. Technical Risks

## RSS Availability

Risk:

> Source RSS có thể lỗi hoặc thay đổi format.

Mitigation:

- Parser validation.
- Retry.
- Error state.
- Source monitoring.

---

## Event Clustering

Risk:

> AI merge nhầm các sự kiện.

Mitigation:

- Conservative clustering.
- Similarity candidate retrieval.
- AI Judge.
- Uncertain → no merge.
- Evaluation dataset.

---

## AI Hallucination

Risk:

> Summary thêm thông tin không có trong nguồn.

Mitigation:

- Source grounding.
- Structured output.
- Evidence Article IDs.
- Validation.
- Retry.

---

## AI Cost

Risk:

> Quá nhiều Article → quá nhiều AI calls.

Mitigation:

```text
Exact dedup
 ↓
Candidate filtering
 ↓
Embedding
 ↓
LLM only when needed
```

---

## Email Reliability

Risk:

> Provider timeout hoặc delivery ambiguity.

Mitigation:

- Idempotency.
- Unknown state.
- Provider reconciliation.
- Webhooks.
- Manual recovery.

---

## SSRF

Risk:

> User nhập URL nội bộ.

Mitigation:

- IP blocking.
- DNS validation.
- Redirect validation.
- DNS rebinding protection.
- Timeout.
- Response limits.

---

## Provider Lock-in

Risk:

> AI/Email provider thay đổi.

Mitigation:

> Provider abstraction.

---

# 65. Implementation Order

Claude Code implementation order:

```text
Phase 1
Project Foundation
        ↓
Phase 2
Authentication
        ↓
Phase 3
Database + Backend Foundation
        ↓
Phase 4
Source Management + RSS + Article
        ↓
Phase 5
AI Dedup + Event Clustering
        ↓
Phase 6
Daily Digest + Email
        ↓
Phase 7
Frontend API Integration
        ↓
Phase 8
Testing + Production Readiness
        ↓
Deployment
```

---

# 66. Phase 1 — Project Foundation

Implement:

- pnpm workspace.
- `apps/web`.
- `apps/server`.
- `packages/contracts`.
- `packages/domain`.
- Existing UI moved into `apps/web`.
- Minimal Fastify server.
- `/health`.
- Environment foundation.
- TypeScript configuration.
- Build/typecheck.

Do NOT implement:

- Authentication.
- Database.
- RSS.
- AI.
- Email.
- Scheduler.

---

# 67. Phase 2 — Authentication

Implement:

- User.
- Password provisioning.
- Argon2id.
- Sessions.
- Login.
- Logout.
- Session middleware.
- CSRF.
- Rate limiting.
- Login UI.
- Protected routes.

---

# 68. Phase 3 — Database + Backend Foundation

Implement:

- PostgreSQL.
- Migration system.
- Database connection.
- Repository/data access.
- User Settings.
- Shared contracts.
- Error handling.
- Transaction support.
- pg-boss.
- Transactional outbox foundation.

---

# 69. Phase 4 — Source + RSS + Article

Implement:

- Source CRUD.
- Soft delete.
- Enable/disable.
- Source status.
- RSS collector.
- SSRF protection.
- RSS parsing.
- Article normalization.
- Exact deduplication.
- Source retry.
- Article processing queue.
- Collection status UI.

---

# 70. Phase 5 — AI

Implement:

- AIProvider interface.
- Provider adapter.
- Embeddings.
- pgvector.
- Candidate retrieval.
- AI Judge.
- Conservative clustering.
- Event creation.
- Vietnamese summary.
- Structured output validation.
- Prompt/model tracking.
- AI retry.
- AI evaluation tests.

---

# 71. Phase 6 — Daily Digest + Email

Implement:

- Daily scheduler.
- JST date calculation.
- 05:30 collection cutoff.
- 06:00 digest generation.
- 06:30 snapshot.
- 06:45 final validation.
- 07:00 email.
- Empty Digest.
- DigestEvent snapshot.
- EmailProvider.
- Idempotency.
- Unknown delivery.
- Provider reconciliation.
- Email preview.

---

# 72. Phase 7 — Frontend API Integration

Connect:

```text
Dashboard
Sources
Source Detail
News & Events
Event Detail
Settings
Digest Preview
```

Replace mock data with API data.

Preserve current visual design.

Add:

- Loading.
- Error.
- Empty.
- Processing states.
- Login.

Do not redesign.

---

# 73. Phase 8 — Testing & Production Readiness

Complete:

- Unit tests.
- Integration tests.
- API tests.
- E2E.
- AI evaluation.
- Security tests.
- SSRF tests.
- Backup/restore validation.
- Migration validation.
- Monitoring.
- Health checks.
- Deployment runbook.

---

# 74. Claude Code Readiness

The following must be finalized before implementation:

```text
Architecture        READY
Tech Stack          READY
Project Structure   READY
Authentication      READY
Database            READY
API                 READY
RSS                 READY
Deduplication       READY
Event Clustering    READY
Summary             READY
Multilingual        READY
Queue               READY
Digest              READY
Late Articles       READY
Cutoff Policy       READY
Email               READY
Timezone            READY
Idempotency         READY
Security            READY
Testing             READY
Deployment          READY
```

---

# 75. Final Recommendation

Technical Specification v1.1 FINAL is the implementation baseline for Claude Code.

Implementation must use:

```text
Product Specification v1.1
        +
Technical Specification v1.1 FINAL
        +
Existing UI
        +
CLAUDE.md
        +
AGENTS.md
```

Claude Code must implement incrementally by Phase.

Do not implement all phases in one operation.

After each Phase:

1. Run tests.
2. Run typecheck.
3. Run build.
4. Review changed files.
5. Verify against Product Specification.
6. Verify against Technical Specification.
7. Stop and report.

The existing UI should be preserved as the visual reference.

The next implementation phase after Phase 1 is:

> **Phase 2 — Authentication**