# Project Context — <project-name>

> Injected as a system-prompt prefix on every guide and dev call for this project.
> Keep it under 60 lines. Be specific. Generic statements waste tokens. A deterministic repo map
> (file tree, module list, exported signatures) is injected separately at every call — do not
> restate it here; narrate what the map can't show (why, conventions, invariants, gotchas).

## Domain
What this software is, in 2-3 sentences. State the bounded scope explicitly.
End with a "Non-goals:" line listing what this is NOT.

## Audience
- Primary user: who they are, business size, role
- Team size and roles inside the customer org
- Device: mobile-first / desktop / mixed; OS preference if relevant
- Tech sophistication: low / medium / high — drives defaults around error messages,
  required guardrails, "are you sure" prompts.

## Geographic & Regulatory
- Country / region of operation. Currency. Default timezone.
- Date format conventions: which format on which surface (user-visible / DB / regulatory artifacts).
- Named regulatory regimes (GST, TDS, DPDP, HIPAA, GDPR, PCI, etc.) that apply.
- Specific schemas/standards the code must conform to (e.g., NSDL FVU v1.8, GSTR-1 v2.0).

## UX & Cultural Conventions
- Primary language(s) and any code-mixing acceptable (e.g., Hinglish in toasts, English in legal docs).
- Currency display format (e.g., ₹X,XX,XXX.XX vs $X,XXX.XX).
- Payment rail priority (UPI > bank > cash > card).
- Primary share/notification channel (WhatsApp > email > SMS).
- Tone register: formal / friendly / minimal — and where each applies.

## Prompting Guidance
Concrete "when X, do Y" rules. Aim for 5-8 — merge overlapping rules rather than listing
near-duplicates. Each rule should be specific enough to prevent a wrong default. Examples:
- When generating invoice or tax-document code: use existing utility helpers
  (cite the path); never invent tax/compliance calculations from scratch.
- When the request involves multi-tenancy: every controller scopes by tenant ID;
  never trust an ID from request body.
- When a regulatory artifact's field is ambiguous in the brief: cite the source
  specification in a code comment and flag uncertainty rather than guess.
- When generating UI copy: forms in English, success/error toasts in the
  preferred conversational style, legal artifacts in formal English.
- Add project-specific examples that prevent the wrong defaults you've seen.
