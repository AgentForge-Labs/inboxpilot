# Attachment-aware classification

InboxPilot can enrich semantic classification with bounded attachment text when the attachment is likely to change the classification outcome.

## Extraction gate

Attachment content is fetched only when all of the following are true:

1. deterministic classification still requires semantic interpretation;
2. the message has document-value signals such as invoice, receipt, finance, travel, legal, government, booking, ticket, contract, tax, or similar document language;
3. the attachment is non-inline and passes file type, size and count policy;
4. a secure extractor exists for parser-based document formats.

An attachment merely existing is not enough to fetch it.

## Allowed formats

The built-in non-executable decoder supports:

- `text/plain`
- `text/csv`

These formats are decoded as UTF-8 text only. Formulae, commands or markup are never executed.

Parser-based formats are allowed only through a `SandboxedAttachmentExtractor`:

- PDF
- DOCX
- XLSX
- PPTX

The sandbox contract requires an isolated process, no network access, no macro execution, no script execution and an ephemeral filesystem. InboxPilot rejects an extractor that does not advertise this exact security profile.

Macro-enabled Office files, executable/script files, HTML/SVG, archives and disk/package formats are denied before attachment bytes are fetched.

## Resource limits

Default limits are:

- 5 MiB per attachment, hard configurable ceiling 25 MiB;
- 3 extracted attachments per message, hard ceiling 10;
- 12,000 extracted characters per attachment;
- 24,000 extracted characters total per message;
- 3 second sandbox timeout, hard ceiling 15 seconds.

Unknown attachment size is denied by default. The content source receives the byte limit and InboxPilot verifies the returned buffer again.

## Data handling and retention

Raw attachment bytes and extracted text are transient classification inputs. They are not added to `CanonicalMessage`, classification state, audit payloads or the normal ingestion store.

After extraction, the fetched disposable Buffer is overwritten with zeroes where practical. The extraction result is used to build one bounded semantic-classifier prompt and is then eligible for garbage collection.

The attachment extraction audit contains only metadata: tenant/account/message/attachment IDs, status/reason, content type, declared size, extracted character count, truncation state and timestamp. Every event explicitly records `contentPersisted: false`.

The content source implementation must return a disposable Buffer copy because InboxPilot zeroizes it after use.

## Prompt safety

Extracted attachment text remains untrusted email data. It passes through the same sanitization and prompt-injection analysis as email bodies. Injection signals found only inside an attachment are included in the classifier trust-boundary metadata.

No attachment content can authorize email actions, tool calls, retention changes or outbound sends. The classifier still returns advisory structured data and downstream policy/authorization remains authoritative.

## Availability behavior

Attachment extraction is optional enrichment. A missing sandbox, rejected format, source failure, timeout or extractor failure is recorded as metadata and classification continues without attachment text. This avoids making ordinary mail processing depend on document parsing infrastructure.
