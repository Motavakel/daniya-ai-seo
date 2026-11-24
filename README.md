# راه‌اندازی PKI محلی Daniya

این بسته برای ساخت PKI محلی با OpenSSL و اتصال آن به Gateway و Caddy آماده شده است.

## معماری

- Root CA: آفلاین و خارج از کانتینرها.
- Client Intermediate CA: فقط برای صدور گواهی کلاینت‌های WordPress؛ کلید آن در اختیار Gateway است.
- Server Intermediate CA: فقط برای صدور گواهی TLS سرور Gateway؛ کلید آن وارد کانتینرها نمی‌شود.
- SEO Service: هیچ کلید یا فایل CA دریافت نمی‌کند.
- Caddy: گواهی Gateway و Client Intermediate CA را دریافت می‌کند و mTLS را بررسی می‌کند.

## ۱. قراردادن فایل‌ها

محتوای این بسته را با همین ساختار در ریشه پروژه‌ای قرار بده که `docker-compose.yml` در آن است. فایل‌های TypeScript را در مسیر Gateway مشخص‌شده کپی کن و snippetها را با فایل‌های موجود ادغام کن.

## ۲. ساخت CA و گواهی Gateway

PowerShell را در ریشه پروژه باز کن:

```powershell
.\scripts\pki\init-local-pki.ps1 -Domain gateway.local
```

سه رمز عبور جداگانه وارد کن. هرکدام حداقل ۱۶ کاراکتر باشند. اسکریپت در صورت مشاهده فایل‌های PKI قبلی متوقف می‌شود تا CA ناخواسته جایگزین نشود.

خروجی در `.local/pki` قرار می‌گیرد. این پوشه نباید وارد Git شود.

## ۳. DNS محلی ویندوز

این خط را با دسترسی Administrator به فایل زیر اضافه کن:

`C:\Windows\System32\drivers\etc\hosts`

```text
127.0.0.1 gateway.local
```

برای اعتماد سیستم‌عامل به Root CA در محیط توسعه:

```powershell
certutil -user -addstore Root .\.local\pki\root-ca\certs\ca.cert.pem
```

برای PHP/cURL در XAMPP ممکن است لازم باشد مسیر Root CA را در `curl.cainfo` و `openssl.cafile` در `php.ini` تنظیم کنی. نصب در Windows Certificate Store لزوماً به معنی اعتماد خودکار همه buildهای PHP/cURL نیست.

در Production از گواهی سرور عمومی معتبر یا توزیع امن trust anchor استفاده کن. کلاینت نباید صرفاً به CAای اعتماد کند که اولین بار در همان پاسخ Enrollment دریافت کرده است.

## ۴. اتصال Docker

محتوای `infrastructure/docker-compose.pki.example.yml` را با سرویس‌های موجود ادغام کن. نام سرویس Gateway در Caddyfile برابر `gateway` و پورت داخلی Nest برابر `3000` فرض شده است؛ با compose واقعی تطبیق بده.

- پورت 3000 Gateway نباید روی Host منتشر شود.
- فقط Caddy پورت‌های 443 و 8444 را منتشر کند.
- پوشه Client CA باید برای Gateway قابل‌نوشتن باشد، چون OpenSSL دیتابیس صدور را به‌روزرسانی می‌کند.
- برای SEO هیچ Volume مربوط به PKI اضافه نکن.

فایل `.env.pki.example` را به `.env` ریشه تبدیل و رمز واقعی Client Intermediate را جایگزین کن. فایل `.env` را commit نکن. خطوط ` .local/pki/ ` و `.env` را هم به `.gitignore` اصلی اضافه کن؛ نمونه در `.gitignore.pki.snippet` است.

## ۵. قرارداد endpointها

- `POST https://gateway.local:8444/oauth/enroll`: بدون mTLS، با Enrollment Token یک‌بارمصرف.
- `POST https://gateway.local/oauth/token`: فقط روی پورت 443 و با mTLS.
- APIهای محافظت‌شده: روی پورت 443 و با mTLS و Bearer Token.

در اولین Enrollment، WordPress باید خودش private key بسازد و فقط CSR را ارسال کند. private key هرگز نباید به Gateway ارسال شود.

پاسخ Enrollment شامل `certificate`، `certificate_chain` و fingerprint است. کلاینت private key خودش را کنار گواهی نگه می‌دارد.

`ca_certificate` در پاسخ فقط برای توزیع/نمایش است؛ WordPress نباید صرفاً به دلیل دریافت آن در پاسخ Enrollment به آن اعتماد کند. Root CA باید از قبل در محیط تست نصب یا از مسیر قابل‌اعتماد دیگری pin شده باشد.

## ۶. ادغام NestJS

1. `CertificateAuthorityService` را در `AuthModule.providers` (نمونه در `auth.module.ts`) اضافه کن.
2. در constructor مربوط به AuthService، `CertificateAuthorityService` را inject کن.
3. متد `enrollClient` را با فایل `auth.service.enroll-client.method.snippet.txt` جایگزین کن.
4. `auth.controller.ts` و `decorators/public.decorator.ts` را اضافه/جایگزین کن؛ اگر decorator عمومی از قبل داری، همان را استفاده کن.
5. فیلد `certificateSerial` را به جدول `oauth_client_certificates` اضافه کن و migration را اجرا کن. snippet در `schema-certificate-serial.snippet.txt` است. Guard نمونه در `guards/access-token.guard.ts` قرار دارد؛ مسیر و import decoratorها را با ساختار فعلی پروژه تطبیق بده.
6. `class-validator` و `class-transformer` باید نصب باشند.

در `AuthController`، با `@Public()` مسیرهای OAuth از Bearer `AccessTokenGuard` مستثنا شده‌اند؛ حفاظت `/oauth/enroll` با Enrollment Token و حفاظت `/oauth/token` با mTLS در Caddy انجام می‌شود. در فایل `auth.service.ts` این importها را اضافه کن: `ConflictException`، `InternalServerErrorException` و `UnauthorizedException` از `@nestjs/common`، و `and`، `eq` و `gt` از `drizzle-orm`. در constructor نیز `private readonly certificateAuthority: CertificateAuthorityService` را اضافه کن و سرویس را import کن. اگر `ConfigModule` در پروژه global نیست، آن را در `AuthModule.imports` اضافه کن.

### Migration برای serial

```sql
ALTER TABLE oauth_client_certificates
ADD COLUMN certificate_serial text;

CREATE UNIQUE INDEX oauth_client_certs_serial_uq
ON oauth_client_certificates (certificate_serial);
```

اگر جدول خالی است می‌توانی ستون را در Drizzle به‌صورت `notNull()` تعریف کنی. برای جدول دارای داده قبلی، migration بالا امن‌تر است؛ گواهی‌های جدید حتماً serial دریافت می‌کنند.

## ۷. Fingerprint

Caddy مقدار SHA-256 fingerprint را به صورت hex بدون colon ارسال می‌کند. Helper تبدیل آن را به Base64URL بدون padding انجام می‌دهد؛ همین مقدار با thumbprint محاسبه‌شده از DER گواهی یکسان است.

به هیچ عنوان پورت Nest را مستقیم به Host منتشر نکن. در غیر این صورت یک کلاینت می‌تواند header مربوط به fingerprint را جعل کند.

## ۸. تست CSR محلی

```powershell
.\scripts\pki\new-test-client.ps1 -Name wordpress-local
```

فایل `client.csr` را برای تست endpoint بفرست و `client.key` را فقط در سمت کلاینت نگه دار.

## محدودیت‌های آگاهانه

- OpenSSL CA یک دیتابیس فایل‌محور دارد. سرویس با mutex صدور را در یک process سریالی می‌کند؛ Gateway را با چند replica هم‌زمان اجرا نکن. برای چند replica باید صدور CA با قفل توزیع‌شده/سرویس PKI اختصاصی یا HSM مدیریت شود.
- این چیدمان برای محیط محلی است. در Production کلیدهای CA باید خارج از image و با Secret Manager یا HSM نگهداری شوند؛ فایل‌های وضعیت CA باید backup و محافظت شوند.
- mTLS در Caddy گواهی را در handshake اعتبارسنجی می‌کند. وضعیت فعال/ابطال، client_id، انقضا و scope همچنان در Gateway و PostgreSQL بررسی می‌شود.
- برای ابطال فوری، Guard باید رکورد دیتابیس را بررسی کند. Caddy به‌تنهایی از تغییر status در PostgreSQL اطلاع ندارد.
- روی Enrollment عمومی Rate Limit و محدودیت اندازه body را در Gateway/Reverse Proxy فعال کن.


-------------------------

```

daniya-ai-seo
├── daniya-gateway
|   ├── src
|   |   ├── common
|   |   |   ├── decorators
|   |   |   |   └── common.decorator.ts
|   |   |   └── mtls
|   |   |       └── cert-fingerprint.ts
|   |   ├── config
|   |   |   ├── config.module.ts
|   |   |   └── env.validation.ts
|   |   ├── database
|   |   |   ├── schema
|   |   |   |   ├── auth.schema.ts
|   |   |   |   ├── customers.schema.ts
|   |   |   |   ├── index.ts
|   |   |   |   └── support.schema.ts
|   |   |   ├── database.constants.ts
|   |   |   └── database.module.ts
|   |   ├── modules
|   |   |   ├── auth
|   |   |   |   ├── dto
|   |   |   |   |   ├── enroll-client.dto.ts
|   |   |   |   |   └── token-request.dto.ts
|   |   |   |   ├── guards
|   |   |   |   |   └── access-token.guard.ts
|   |   |   |   ├── auth.constants.ts
|   |   |   |   ├── auth.controller.ts
|   |   |   |   ├── auth.module.ts
|   |   |   |   ├── auth.service.ts
|   |   |   |   └── client-cert.repository.ts
|   |   |   ├── certificate-authority
|   |   |   |   ├── certificate-authority.module.ts
|   |   |   |   └── certificate-authority.service.ts
|   |   |   ├── customers
|   |   |   |   ├── customers.module.ts
|   |   |   |   └── customers.service.ts
|   |   |   └── scans
|   |   |       ├── dto
|   |   |       |   └── create-scan.dto.ts
|   |   |       ├── scans.controller.ts
|   |   |       ├── scans.module.ts
|   |   |       ├── scans.service.ts
|   |   |       ├── seo-client.service.ts
|   |   |       └── seo-jwt.service.ts
|   |   ├── redis
|   |   |   ├── redis.constants.ts
|   |   |   └── redis.module.ts
|   |   ├── app.module.ts
|   |   └── main.ts
|   ├── .env
|   ├── .gitignore
|   ├── .prettierrc
|   ├── Dockerfile
|   ├── eslint.config.mjs
|   ├── nest-cli.json
|   ├── package.json
|   ├── package-lock.json
|   ├── README.md
|   ├── tsconfig.build.json
|   └── tsconfig.json
├── daniya-seo
|   ├── scripts
|   |   ├── check-runtime.ts
|   |   ├── lighthouse-smoke.ts
|   |   ├── netlog-parse-smoke.ts
|   |   ├── network-audit.cjs
|   |   ├── network-capture-smoke.ts
|   |   └── network-diagnostic.cjs
|   ├── src
|   |   ├── certs
|   |   |   └── gateway-public.pem
|   |   ├── core
|   |   |   └── config
|   |   |       ├── bullmq.config.ts
|   |   |       ├── config.module.ts
|   |   |       ├── drizzle.config.ts
|   |   |       └── validation.schema.ts
|   |   ├── infrastructure
|   |   |   ├── database
|   |   |   |   ├── schema
|   |   |   |   |   ├── access
|   |   |   |   |   |   ├── customer-plan-cycles.schema.ts
|   |   |   |   |   |   ├── customers.schema.ts
|   |   |   |   |   |   ├── page-cycle-slots.schema.ts
|   |   |   |   |   |   └── pages.schema.ts
|   |   |   |   |   ├── workflow
|   |   |   |   |   |   ├── idempotency-records.schema.ts
|   |   |   |   |   |   ├── lighthouse-runs.schema.ts
|   |   |   |   |   |   ├── network-runs.schema.ts
|   |   |   |   |   |   ├── outbox-events.schema.ts
|   |   |   |   |   |   ├── report-artifacts.schema.ts
|   |   |   |   |   |   ├── scan-engine-runs.schema.ts
|   |   |   |   |   |   └── scans.schema.ts
|   |   |   |   |   ├── enums.schema.ts
|   |   |   |   |   ├── index.ts
|   |   |   |   |   └── schema.types.ts
|   |   |   |   ├── database.constants.ts
|   |   |   |   ├── database.module.ts
|   |   |   |   └── drizzle.service.ts
|   |   |   ├── outbox
|   |   |   |   ├── outbox.module.ts
|   |   |   |   └── outbox-publisher.service.ts
|   |   |   ├── queue
|   |   |   |   ├── queue.constants.ts
|   |   |   |   └── queue.module.ts
|   |   |   └── storage
|   |   |       └── artifact-storage.service.ts
|   |   ├── modules
|   |   |   ├── access
|   |   |   |   ├── services
|   |   |   |   |   ├── access.service.ts
|   |   |   |   |   ├── cycle-lifecycle.service.ts
|   |   |   |   |   ├── plan-resolver.service.ts
|   |   |   |   |   └── quota.service.ts
|   |   |   |   ├── access.module.ts
|   |   |   |   └── access.repository.ts
|   |   |   ├── api
|   |   |   |   ├── controllers
|   |   |   |   |   ├── account.controller.ts
|   |   |   |   |   ├── report.controller.ts
|   |   |   |   |   └── scan-controller.ts
|   |   |   |   ├── decorators
|   |   |   |   |   ├── current-principal.decorator.ts
|   |   |   |   |   ├── idempotency-key.decorator.ts
|   |   |   |   |   └── require-gateway-scopes.decorator.ts
|   |   |   |   ├── dto
|   |   |   |   |   ├── create-scan.dto.ts
|   |   |   |   |   ├── repurchase.dto.ts
|   |   |   |   |   └── upgrade-plan.dto.ts
|   |   |   |   ├── gurds
|   |   |   |   |   ├── gateway-auth.guard.ts
|   |   |   |   |   └── gateway-scope.guard.ts
|   |   |   |   ├── api.module.ts
|   |   |   |   └── gateway-context.ts
|   |   |   ├── engines
|   |   |   |   ├── browser
|   |   |   |   |   └── browser-runner.service.ts
|   |   |   |   ├── console
|   |   |   |   |   ├── console.engine.ts
|   |   |   |   |   └── console.parser.ts
|   |   |   |   ├── lighthouse
|   |   |   |   |   ├── lighthouse.engine.ts
|   |   |   |   |   └── lighthouse.parser.ts
|   |   |   |   ├── network
|   |   |   |   |   ├── network.engine.ts
|   |   |   |   |   └── network.parser.ts
|   |   |   |   ├── performance
|   |   |   |   |   ├── performance.engine.ts
|   |   |   |   |   └── performance.parser.ts
|   |   |   |   └── engines.module.ts
|   |   |   ├── reports
|   |   |   |   ├── reports.controller.ts
|   |   |   |   ├── reports.module.ts
|   |   |   |   ├── reports.repository.ts
|   |   |   |   └── reports.service.ts
|   |   |   ├── security
|   |   |   |   ├── security.module.ts
|   |   |   |   └── target-url.validator.ts
|   |   |   └── workflow
|   |   |       ├── services
|   |   |       |   ├── idempotency.service.ts
|   |   |       |   ├── page-resolver.service.ts
|   |   |       |   ├── slot-reservation.service.ts
|   |   |       |   └── workflow.service.ts
|   |   |       ├── workflow.module.ts
|   |   |       └── workflow.repository.ts
|   |   ├── worker
|   |   |   ├── scan.processor.ts
|   |   |   ├── scan-orchestrator.service.ts
|   |   |   ├── scan-results.repository.ts
|   |   |   ├── worker.main.ts
|   |   |   └── worker.module.ts
|   |   ├── app.module.ts
|   |   └── main.ts
|   ├── .dockerignore
|   ├── .env
|   ├── .gitignore
|   ├── .prettierrc
|   ├── Apply-QC-Fixes.ps1
|   ├── drizzle.config.ts
|   ├── ENV-ADDITIONS.txt
|   ├── jest.config.ts
|   ├── nest-cli.json
|   ├── oxlint.json
|   ├── package.json
|   ├── package.json.additions.json
|   ├── package-lock.json
|   ├── tsconfig.build.json
|   └── tsconfig.json
├── scripts
|   ├── pki
|   |   ├── config
|   |   |   ├── intermediate-ca.cnf
|   |   |   └── root-ca.cnf
|   |   ├── init-local-pki.ps1
|   |   └── new-test-client.ps1
|   └── show-tree.ps1
├── .dockerignore
├── .env.pki
├── .gitignore.pki.snippet
├── Caddyfile
├── compose.local.yaml
├── compose.prod.yaml
├── compose.yaml
└── README.md
```


نمته مهم انکه وقای مقدار شاخص 
LCP 
ریاد باشد باید پرفورمسن  و بخش 
LCP Breackdown

وقتی شاخص 
cls
مقدار بالیی داره باید  بخش مربوط به این شاخص بررسی بشه

وقتی شاخص 
FCP
بالا باشد ، باید فشرده کردن رندر بلاک ها بررسی شود