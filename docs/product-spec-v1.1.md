# AI Daily News Digest

## Product Specification — MVP v1.1

**Document Status:** Finalized Product Definition  
**Version:** v1.1  
**Product Type:** Responsive Web App + Daily Email Digest  
**MVP Platform:** Responsive Web App  
**Primary Consumption:** Daily Email  
**Primary Timezone:** Asia/Tokyo (JST)

---

# 1. Product Overview

AI Daily News Digest là hệ thống tự động theo dõi nhiều nguồn tin tức, thu thập các bài viết mới trong ngày, sử dụng AI để nhận diện những bài viết cùng nói về một sự kiện, gom chúng thành một Event duy nhất và tạo bản tóm tắt.

Vào **07:00 JST mỗi ngày**, hệ thống gửi **một Daily Digest Email duy nhất** chứa các Event thuộc **ngày dương lịch trước đó theo múi giờ Asia/Tokyo**.

Ví dụ:

```text
11/11/2026
     ↓
Thu thập tin
     ↓
AI phân tích
     ↓
Articles → Events
     ↓
Tạo Summary
     ↓
12/11/2026 07:00 JST
     ↓
📧 Tin nhanh ngày 11
```

---

# 2. Problem Statement

User muốn cập nhật tin tức từ nhiều nguồn nhưng gặp:

- Quá nhiều nguồn.
- Nhiều bài cùng đưa một sự kiện.
- Tiêu đề và cách viết khác nhau.
- Khó nhận biết bài nào trùng nhau.
- Mất thời gian đọc và so sánh.
- Information overload.

Sản phẩm giải quyết:

> **Information overload + Duplicate news + Manual filtering**

bằng cách biến nhiều bài viết thành các Event có ý nghĩa.

---

# 3. Target User

## MVP

MVP phục vụ **một User chính**.

User có thể:

- Quản lý nguồn tin.
- Xem Articles và Events.
- Cấu hình email nhận Digest.
- Nhận một Daily Digest mỗi ngày.

MVP không triển khai multi-user.

---

# 4. Product Goals

User có thể:

1. Thêm nhiều nguồn.
2. Hệ thống tự động thu thập Article.
3. AI phát hiện duplicate/related Articles.
4. Gom Articles thành Event.
5. Tạo Summary.
6. Tạo Daily Digest.
7. Nhận một email lúc 07:00 JST.
8. Nhanh chóng hiểu các sự kiện của ngày hôm trước.
9. Có thể mở nguồn gốc để kiểm tra thông tin.

---

# 5. Core Value Proposition

> **Read less. Know more.**

Core flow:

```text
Many Sources
     ↓
Many Articles
     ↓
Deduplication
     ↓
Event Clustering
     ↓
Summarization
     ↓
Daily Digest
     ↓
One Email
```

---

# 6. Core Domain Model

Đây là quy tắc nền tảng của sản phẩm.

## Source

Một nguồn tin được User cấu hình.

Ví dụ:

```text
VTV
VnExpress
NHK
CNN
```

Một Source có thể tạo ra nhiều Article.

---

## Article

Article là **một bài viết cụ thể từ một Source**.

Ví dụ:

```text
Source:
VTV

Article:
"Bão X gây ảnh hưởng..."
```

Article phải giữ:

- Source.
- Title.
- Published Time.
- Original URL.
- Nội dung cần thiết cho processing.
- Processing status.

---

## Event

Event là **một sự kiện thực tế được tạo từ một hoặc nhiều Article**.

Ví dụ:

```text
VTV Article A ─────┐
NHK Article B ─────┼──→ Event: Bão X đổ bộ
CNN Article C ─────┘
```

Một Event có thể có:

- Một Article.
- Nhiều Article.
- Một Source.
- Nhiều Source.

Điều quan trọng:

> **Article là bài viết. Event là sự kiện thực tế mà các bài viết đang nói đến.**

---

## Daily Digest

Daily Digest là tập hợp các Event thuộc **một ngày cụ thể**.

Ví dụ:

```text
Daily Digest
Date: 11/11/2026

Event 1
Bão X...

Event 2
Nhật Bản công bố...

Event 3
Mỹ thông báo...
```

---

## Relationship

```text
Source
 ↓
Article
 ↓
Event
 ↓
Daily Digest
 ↓
Email
```

Về mặt quan hệ:

```text
Source
  │
  └── 1:N → Article
                │
                └── N:1 → Event
                              │
                              └── N:M → Daily Digest
```

Trong MVP:

- Một Article thuộc tối đa một Event.
- Một Event có thể chứa nhiều Article.
- Một Event có thể xuất hiện trong nhiều Daily Digest.
- Một Daily Digest có nhiều Event.

---

# 7. MVP Scope

## 7.1 Source Management

User có thể:

- View Source.
- Add Source.
- Edit Source.
- Enable Source.
- Disable Source.
- Delete Source.
- View Source status.

### Source fields

```text
Name
Website URL
RSS URL (optional)
Enabled
Status
```

---

# 8. Source Behavior

## 8.1 Source Input

MVP hỗ trợ:

> **Website URL + Optional RSS URL**

RSS là phương thức thu thập **ưu tiên** khi Source có RSS.

Nếu Source không có RSS:

> MVP **không cam kết arbitrary website crawling**.

Website URL vẫn được lưu để:

- Hiển thị thông tin Source.
- Làm Original Source.
- Chuẩn bị cho future crawler capability.

### Ví dụ

```text
VnExpress
Website ✓
RSS ✓
→ Collect via RSS

Một Website không có RSS
Website ✓
RSS ✗
→ Source tồn tại nhưng chưa được đảm bảo auto collection trong MVP
```

---

# 9. Source Lifecycle

Source có các trạng thái:

```text
Active
Disabled
Error
```

### Active

Được phép thu thập Article.

### Disabled

Không thu thập Article mới.

### Error

Source đang gặp vấn đề thu thập.

Error của một Source không được làm dừng các Source khác.

---

# 10. Delete Source

Khi User xóa Source:

```text
Source
   ↓
Removed from active monitoring
```

Nhưng:

> **Historical Articles và Events đã được thu thập không bị xóa.**

Mục đích:

User xóa VTV hôm nay nhưng vẫn có thể xem:

> Tin VTV đã được tổng hợp ngày hôm qua.

Xóa Source trong MVP là thao tác ngừng theo dõi/archiving, không phải xóa lịch sử.

---

# 11. News Collection

Hệ thống tự động:

1. Kiểm tra Active Sources.
2. Thu thập Articles mới.
3. Lưu Article.
4. Gắn Article với Source.
5. Xác định Published Time.
6. Phát hiện Article đã tồn tại.
7. Đưa Article mới vào AI processing.

Exact duplicate phải được loại bỏ trước khi tạo processing task trùng.

---

# 12. AI Processing

AI có ba nhiệm vụ chính:

## 12.1 Deduplication

Phát hiện:

> Đây có phải cùng một Article / nội dung đã được xử lý không?

---

## 12.2 Event Clustering

Phát hiện:

> Hai hoặc nhiều Articles có đang nói về cùng một real-world Event không?

Ví dụ:

```text
VTV:
Bão X đổ bộ...

VnExpress:
Bão X gây ảnh hưởng...

NHK:
Typhoon X hits...
```

→

```text
1 Event
3 Articles
3 Sources
```

---

## 12.3 Summarization

Tạo:

- Event Title.
- Event Summary.

Summary phải:

- Ngắn gọn.
- Chính xác.
- Dựa trên Article.
- Không tự thêm thông tin.
- Dễ đọc.
- Bằng tiếng Việt.

---

# 13. AI Confidence

**Không hiển thị AI Confidence cho User trong MVP.**

Confidence có thể được sử dụng nội bộ nếu cần cho:

- Processing.
- Debugging.
- Monitoring.
- Future quality improvement.

Nhưng không xuất hiện trong UI chính.

---

# 14. Collection Success Rate

**Không hiển thị Collection Success Rate trong MVP.**

Thay vào đó User chỉ cần thấy trạng thái đơn giản:

```text
● Healthy
● Error
● Disabled
```

Chi tiết metrics có thể được đưa vào:

> Internal Monitoring / Future Analytics.

---

# 15. News & Events

MVP có một màn hình:

> **News & Events**

Màn hình cho phép User:

- Xem Events.
- Tìm kiếm.
- Lọc theo ngày.
- Lọc theo Source.
- Mở Event Detail.

Không cần xây dựng một Article Management Dashboard riêng trong MVP.

Articles được xem trong:

- Event Detail.
- Source Detail.

---

# 16. MVP Search & Filter

## Search

Cho phép tìm kiếm theo:

- Event Title.
- Article Title.
- Source Name.

Không cần full-text search nội dung Article trong MVP.

---

## Filters

MVP hỗ trợ:

### Date

Chọn ngày cần xem.

### Source

Lọc theo Source.

Không cần các filter:

- Content Type.
- Processing Status.
- AI Confidence.
- Importance.

---

# 17. Event Ordering

MVP sử dụng thứ tự:

> **Latest relevant publication/update time first.**

Event mới được cập nhật gần nhất sẽ đứng trước.

Chưa triển khai AI Importance Ranking trong MVP.

---

# 18. Daily Digest

Daily Digest được tạo theo **calendar date của Asia/Tokyo**.

Ví dụ:

```text
News Date:
11/11/2026

Digest:
Tin nhanh ngày 11

Send:
12/11/2026 07:00 JST
```

---

# 19. Daily Digest Schedule

MVP cố định:

```text
Timezone:
Asia/Tokyo

Send Time:
07:00 JST

Frequency:
Once per day
```

User **không thay đổi Timezone hoặc Send Time trong MVP**.

UI có thể hiển thị:

```text
Timezone
Asia/Tokyo

Digest time
07:00 JST
```

nhưng các giá trị này là:

> **Read-only trong MVP.**

---

# 20. Daily Digest Date Boundary

Article được xác định thuộc ngày nào dựa trên:

> `Published Time → Asia/Tokyo`

Ví dụ:

```text
11/11 23:50 JST
→ Digest 11/11
→ Send 12/11 07:00
```

Trong khi:

```text
12/11 00:05 JST
→ Digest 12/11
→ Send 13/11 07:00
```

Ngày của Digest không dựa vào thời điểm Email được gửi.

---

# 21. One Email Per Day

Dù có:

```text
5 Sources
20 Sources
100 Sources
```

User chỉ nhận:

```text
1 Daily Digest Email / Day
```

Không gửi một Email cho từng Source.

---

# 22. Empty Digest

Nếu ngày hôm trước không có Event phù hợp:

> **Vẫn gửi Daily Digest Email.**

Digest được tạo với:

```text
0 Events
```

Không cần một trạng thái `empty` riêng trong MVP.

Ví dụ:

### Subject

> Tin nhanh ngày 11

### Content

> Hôm nay không có tin nổi bật được tổng hợp từ các nguồn của bạn.  
> Hệ thống sẽ tiếp tục theo dõi và gửi bản tin vào ngày mai.

Mục đích:

User luôn biết hệ thống đã chạy và không phải tự đoán:

> "Không có email là do không có tin hay hệ thống bị lỗi?"

---

# 23. Email Content

Mỗi Event trong Email gồm:

```text
Event Title

Sources

Summary

Original Article Links
```

Ví dụ:

```text
📰 Bão X đổ bộ khu vực Y

Nguồn:
VTV · VnExpress · NHK

Tóm tắt:
Bão X đã...

[Đọc nguồn]
```

Digest language:

> **Vietnamese**

Original Article title/content remains in the original language.

---

# 24. Email Subject

MVP:

> **Tin nhanh ngày {DD}**

Ví dụ:

> Tin nhanh ngày 11

Ngày đầy đủ có thể xuất hiện bên trong Email.

---

# 25. Email Failure

Nếu Email delivery thất bại:

- Ghi nhận failure.
- Retry khi an toàn.
- Không tạo Daily Digest mới.
- Không gửi duplicate sau khi retry thành công.
- Nếu trạng thái delivery không xác định, phải reconcile trước khi retry.

Một Daily Digest chỉ được coi là:

> **Sent**

khi provider đã chấp nhận yêu cầu gửi.

Delivery confirmation được theo dõi riêng nếu provider hỗ trợ.

---

# 26. AI Failure

Nếu AI processing thất bại:

- Article không bị xóa.
- Article vẫn được lưu.
- Article có thể retry.
- Một Article lỗi không làm dừng toàn bộ pipeline.
- Không ghi đè dữ liệu Event hợp lệ bằng AI output không hợp lệ.

---

# 27. Source Failure

Nếu một Source lỗi:

```text
VTV ❌
NHK ✓
CNN ✓
BBC ✓
```

thì:

- NHK/CNN/BBC vẫn tiếp tục.
- VTV được đánh dấu Error.
- VTV có thể retry.
- User có thể xem Source đang Error.

---

# 28. Late-Arriving Article

Article có thể được phát hiện sau ngày xuất bản.

Ví dụ:

```text
Published:
11/11 23:50 JST

Discovered:
12/11 08:00 JST
```

Article:

- Vẫn được lưu.
- Vẫn được xử lý.
- Được đánh dấu `late_arrival`.
- Có thể được liên kết với Event.
- Không làm thay đổi Digest 11 đã gửi.
- Không trigger email thứ hai.

Nếu Article mới thuộc ngày 12/11 thì có thể góp phần vào Digest 12 theo quy tắc bình thường.

---

# 29. Missed Digest Cutoff

Một Article có thể đã tồn tại trong hệ thống nhưng chưa hoàn tất processing trước thời điểm snapshot.

Trường hợp này được phân biệt với Late Arrival.

> **Missed Digest Cutoff** = Article không hoàn tất processing trước thời điểm snapshot của Digest.

Article:

- Vẫn được lưu.
- Vẫn tiếp tục xử lý.
- Được đánh dấu `missed_digest_cutoff`.
- Không được đưa vào Digest đã snapshot.
- Không trigger email thứ hai.

---

# 30. Daily Digest Cutoff

MVP ưu tiên:

> **On-time delivery over complete coverage.**

Lịch xử lý khái niệm:

```text
05:30 JST
Collection cutoff

06:00 JST
Generate Digest

06:30 JST
Create/finalize snapshot

06:45 JST
Final validation / snapshot cutoff

07:00 JST
Send one email
```

Nếu một số Article/AI processing chưa hoàn thành lúc 06:45:

> Không chờ thêm.

Hệ thống gửi **latest valid snapshot** lúc 07:00.

Các Article chưa hoàn tất:

- Không xuất hiện trong Digest đó.
- Tiếp tục xử lý sau 07:00.
- Không tạo Email thứ hai.

---

# 31. Event Across Multiple Days

Một Event không thuộc cố định một ngày.

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

Cùng một Event có thể xuất hiện trong nhiều Daily Digest.

Digest membership dựa trên Articles đủ điều kiện của từng ngày.

---

# 32. Sent Digest Immutability

Sau khi:

```text
DailyDigest.status = sent
```

Digest không được thay đổi.

Không:

- Add Event.
- Remove Event.
- Change Event order.
- Change Summary snapshot.
- Change Article snapshot.
- Regenerate Email.
- Resend Email.

Current Event data có thể tiếp tục thay đổi độc lập với historical Digest.

---

# 33. Web App

MVP gồm:

```text
/login

Dashboard

Sources
 ├── Source List
 ├── Add Source
 ├── Edit Source
 └── Source Detail

News & Events
 ├── Event List
 └── Event Detail

Settings

Email Preview
```

Login là màn hình bổ sung nhỏ cần có cho MVP authentication.

---

# 34. Authentication

MVP:

> **Public Web App + Single Admin User + Login**

Không có:

- Multi-user.
- Social Login.
- Google Login.
- Roles.
- Workspace management.
- Public registration.

Authentication được thực hiện bằng:

> Server-side session + HttpOnly Secure cookie.

Không lưu authentication token trong `localStorage`.

---

# 35. Dashboard

Dashboard hiển thị:

- Active Sources.
- Articles Collected.
- Events Detected.
- Latest Digest.
- System Status.
- Latest Events.

Không triển khai Advanced Analytics.

Không hiển thị:

- AI Confidence.
- Collection Success Rate.

---

# 36. Source Management UI

Source List:

```text
Source
Status
Last Sync
Articles
Actions
```

Actions:

- Edit.
- Enable / Disable.
- Delete.

Delete phải có confirmation.

---

# 37. Source Detail

Hiển thị:

- Source information.
- Website.
- RSS.
- Status.
- Last successful sync.
- Recent Articles.
- Error information.

Không hiển thị Collection Success Rate.

---

# 38. Event Detail

Hiển thị:

- Event Title.
- Summary.
- Sources.
- Related Articles.
- Published/Updated information.
- Original Article links.

Không hiển thị AI Confidence.

---

# 39. Settings

MVP:

```text
Recipient Email

Timezone:
Asia/Tokyo

Digest Time:
07:00 JST
```

Chỉ:

> Recipient Email

có thể chỉnh sửa.

Timezone và Digest Time:

> **Read-only.**

---

# 40. Email Preview

User có thể preview Daily Digest.

Preview chứa:

- Email Header.
- Date.
- Subject.
- Events.
- Sources.
- Summary.
- Original links.
- Footer.

Preview không đồng nghĩa với Email đã gửi.

Phải hỗ trợ Empty Digest Preview.

---

# 41. Business Rules

## BR-001

Một User nhận tối đa một Daily Digest Email cho mỗi ngày.

## BR-002

Daily Digest ngày D chứa Events có Article đủ điều kiện thuộc ngày D.

## BR-003

Daily Digest ngày D được gửi lúc 07:00 JST ngày D+1.

## BR-004

Mọi Article được xác định ngày theo Asia/Tokyo.

## BR-005

Một Event có thể có nhiều Article.

## BR-006

Một Event có thể có nhiều Source thông qua Articles.

## BR-007

Một Article thuộc tối đa một Event trong MVP.

## BR-008

Một Event có thể xuất hiện trong nhiều Daily Digest.

## BR-009

Xóa Source không xóa Historical Articles hoặc Events.

## BR-010

Source Error không ảnh hưởng Source khác.

## BR-011

AI Error không làm mất Article.

## BR-012

Email Retry phải idempotent.

## BR-013

Empty Digest vẫn gửi Email.

## BR-014

MVP không cho User thay đổi Timezone.

## BR-015

MVP không cho User thay đổi Digest Time.

## BR-016

MVP không hiển thị AI Confidence.

## BR-017

MVP không hiển thị Collection Success Rate.

## BR-018

Late Article không làm thay đổi Digest đã gửi.

## BR-019

Digest đã gửi là immutable.

## BR-020

MVP không đảm bảo arbitrary website crawling.

---

# 42. UX States

## Source

- Loading.
- Empty.
- Active.
- Disabled.
- Error.
- Saving.
- Save Success.
- Save Error.
- Delete Confirmation.

## Article

- Loading.
- Available.
- Processing.
- Processing Failed.
- Empty.

## Event

- Loading.
- Available.
- Processing.
- Processing Failed.
- Empty.

## Daily Digest

- Not Generated.
- Generating.
- Ready.
- Sending.
- Sent.
- Failed.
- Empty content.

Empty content không yêu cầu một Digest status riêng.

---

# 43. Acceptance Criteria

## AC-001 — Add Source

```text
Given
User nhập Source Name và Website URL hợp lệ

When
User Save

Then
Source được tạo
và xuất hiện trong Source List.
```

---

## AC-002 — RSS

```text
Given
User nhập RSS URL

When
Source được lưu

Then
RSS URL được lưu cùng Source.
```

---

## AC-003 — Disable Source

```text
Given
Source đang Active

When
User Disable Source

Then
Source chuyển sang Disabled
và không được sử dụng cho Collection mới.
```

---

## AC-004 — Delete Source

```text
Given
Source tồn tại

When
User xác nhận Delete

Then
Source không còn được monitor
nhưng Historical Articles và Events vẫn tồn tại.
```

---

## AC-005 — Article Collection

```text
Given
Source đang Active
và có Article mới

When
Collection chạy

Then
Article được lưu
và liên kết với Source.
```

---

## AC-006 — Duplicate Article

```text
Given
Article đã tồn tại

When
hệ thống thu thập lại cùng Article

Then
không tạo Article duplicate.
```

---

## AC-007 — Event Clustering

```text
Given
nhiều Article từ nhiều Source
mô tả cùng một real-world Event

When
AI processing hoàn thành

Then
Articles được group thành một Event.
```

---

## AC-008 — Different Events

```text
Given
hai Articles mô tả hai real-world Events khác nhau

When
AI processing hoàn thành

Then
hai Articles không được merge thành một Event.
```

---

## AC-009 — Event Summary

```text
Given
Event đã được tạo

When
AI summarization hoàn thành

Then
Event có Title và Summary bằng tiếng Việt.
```

---

## AC-010 — Search

```text
Given
News & Events có nhiều Events

When
User nhập từ khóa

Then
hệ thống tìm trong:
- Event Title
- Article Title
- Source Name
```

---

## AC-011 — Filter Date

```text
Given
Events thuộc nhiều ngày

When
User chọn một ngày

Then
chỉ hiển thị Events có Article đủ điều kiện thuộc ngày đó.
```

---

## AC-012 — Filter Source

```text
Given
Events từ nhiều Sources

When
User chọn Source

Then
chỉ hiển thị Events có Article từ Source đó.
```

---

## AC-013 — Digest Date

```text
Given
Event có Article thuộc 11/11/2026 JST

When
Digest ngày 11 được tạo

Then
Event có thể xuất hiện trong Digest ngày 11.
```

---

## AC-014 — Event Across Days

```text
Given
Event A có Article thuộc 11/11

And
Event A có Article mới thuộc 12/11

When
Digest 11 và Digest 12 được tạo

Then
Event A có thể xuất hiện trong cả hai Digest
với snapshot riêng của từng Digest.
```

---

## AC-015 — Date Boundary

```text
Given
Article published at 12/11/2026 00:05 JST

When
Digest ngày 11 được tạo

Then
Article không xuất hiện trong Digest ngày 11.
```

---

## AC-016 — Daily Email

```text
Given
Daily Digest ngày 11 đã có valid snapshot

When
thời gian là 12/11/2026 07:00 JST

Then
User nhận một Email
cho Digest ngày 11.
```

---

## AC-017 — Empty Digest

```text
Given
không có Event phù hợp cho ngày 11

When
12/11/2026 07:00 JST

Then
User vẫn nhận Email
với Empty Digest content.
```

---

## AC-018 — Cutoff

```text
Given
một Article chưa hoàn thành AI processing
trước 06:45 JST

When
07:00 JST

Then
Digest được gửi bằng latest valid snapshot
và Article đó không được thêm vào Digest đã gửi.
```

---

## AC-019 — Late Article

```text
Given
Article published 11/11
nhưng discovered 12/11 08:00 JST

When
Digest 11 đã được gửi

Then
Article vẫn được lưu và xử lý
nhưng Digest 11 không thay đổi
và không có Email thứ hai.
```

---

## AC-020 — Source Failure

```text
Given
VTV bị lỗi

When
Daily collection chạy

Then
NHK, CNN và các Source khác
vẫn tiếp tục được xử lý.
```

---

## AC-021 — AI Failure

```text
Given
AI không xử lý được Article

When
AI processing chạy

Then
Article vẫn được lưu
và có thể retry.
```

---

## AC-022 — Email Failure

```text
Given
Email delivery không xác định kết quả

When
Provider status được reconcile

Then
nếu Email đã được chấp nhận/gửi
không được gửi lại.

Nếu Provider xác nhận chưa nhận
thì có thể retry an toàn theo idempotency policy.
```

---

# 44. Out of Scope

MVP không bao gồm:

- Native Mobile.
- Multi-user.
- Social Login.
- Advanced Analytics.
- AI Chat.
- Recommendation Engine.
- Personalized Ranking.
- Push Notification.
- Payment.
- Subscription.
- Enterprise permissions.
- AI Confidence UI.
- Collection Success Rate UI.
- Advanced Search.
- Advanced Event Ranking.
- Custom Digest Schedule.
- Custom Timezone.
- Arbitrary website crawling.
- Full Article Translation.
- Resending an already sent Digest.

---

# 45. Future Scope

Có thể phát triển sau MVP:

### User

- Multi-user.
- User accounts.
- Personalized sources.
- Custom schedules.
- Multiple users/workspaces.

### News

- Website crawler.
- Topic subscriptions.
- Importance ranking.
- Breaking News.
- Full-text search.
- Bookmark.
- Read Later.

### AI

- AI Chat.
- Personalized summaries.
- Translation.
- Advanced clustering.
- Advanced AI quality metrics.

### Delivery

- Push Notifications.
- Multiple daily digests.
- Slack / Discord / other channels.

### Platform

- Native Mobile App.
- Advanced analytics.
- Subscription.
- Payment.

---

# 46. Product Decisions — v1.1

| Decision | MVP |
|---|---|
| Platform | Responsive Web App |
| Primary Delivery | Email |
| User | Single Admin User |
| Authentication | Login + Server-side Session |
| Timezone | Asia/Tokyo |
| Send Time | 07:00 JST |
| Schedule | Fixed |
| Digest Frequency | Once/day |
| Digest Date | Previous calendar day |
| Source | Website URL + optional RSS URL |
| Collection | RSS-first |
| Arbitrary Web Crawling | Future |
| Article | Individual source article |
| Event | Real-world event |
| Article → Event | Maximum one Event |
| Event → Articles | Multiple |
| Event → Digest | Multiple Digests |
| Digest → Events | Multiple |
| Source Delete | Yes, soft delete |
| Historical Data | Preserved |
| AI | Dedup + Event Clustering + Summary |
| AI Output Language | Vietnamese |
| Original Article Language | Preserved |
| AI Confidence UI | No |
| Collection Success Rate UI | No |
| Search | Event Title + Article Title + Source Name |
| Filter | Date + Source |
| Event Ordering | Latest relevant publication/update time |
| Empty Digest | Send email |
| Digest Cutoff | 06:45 JST |
| Email | 07:00 JST |
| Custom Timezone | No |
| Custom Send Time | No |
| Native Mobile | No |

---

# 47. Product Specification Status

> **Product Specification v1.1 is the baseline product definition for MVP implementation.**

Các quyết định sản phẩm quan trọng đã được chốt.

Các vấn đề còn lại thuộc Technical Specification hoặc Implementation Detail.

---

# 48. MVP Success Condition

> User có thể cấu hình nhiều nguồn và mỗi sáng nhận **một email duy nhất lúc 07:00 JST** chứa các sự kiện đáng chú ý của ngày hôm trước, trong đó nhiều bài báo về cùng một sự kiện được AI gom thành một Event và tóm tắt bằng tiếng Việt.

Core loop:

```text
Configure Sources
        ↓
Collect Articles
        ↓
Deduplicate
        ↓
Cluster Events
        ↓
Summarize in Vietnamese
        ↓
Generate Daily Digest
        ↓
Snapshot before 07:00
        ↓
07:00 JST
        ↓
One Email
        ↓
User reads important events
```