# Hybrid importance engine

InboxPilot evaluates cheap deterministic evidence before sending message content to a semantic/LLM classifier.

## Purpose

`scoreDeterministicImportance()` produces an explainable 0–100 importance score, confidence, priority bucket, category hints and an explicit `needsLlm` decision.

The deterministic layer does **not** authorize mailbox actions and does not replace the canonical classifier contract. It is a routing/scoring layer used before semantic classification.

## Signals

The v1 engine uses:

- trusted contacts and sender/domain allowlists
- prior user replies and sender interaction history
- domain interaction history
- direct recipient matching
- mailing-list / List-Unsubscribe / Precedence bulk headers
- previous user participation in the thread
- deadline/due-date language
- monetary amounts
- explicit action verbs
- invoice/payment-due indicators
- receipt/payment-confirmation indicators
- account-security / verification context
- suspicious DKIM/DMARC/authentication signals
- reply versus new-conversation pattern

Each applied signal is returned as an `ImportanceContribution` with a signed weight and human-readable reason.

## LLM routing

The deterministic engine skips an LLM call only for clear extremes:

- high-confidence important mail: high score, multiple strong positive signals, no conflicting bulk evidence
- high-confidence bulk mail: very low score, multiple strong negative bulk/list signals and no strong positive evidence

Messages with conflicting evidence, weak evidence or mid-range semantic ambiguity are marked `needsLlm=true`.

Webhook/provider metadata is not sufficient on its own to make a semantic decision.

## Safety

Security/authentication failures increase attention rather than automatically classifying a message as phishing. The semantic classifier or later phishing/security logic must make that distinction.

Likewise, invoice, receipt and security regex matches create category hints only. The final canonical categories remain the responsibility of the classifier contract.

The engine never directly archives, trashes, marks important or sends replies.
