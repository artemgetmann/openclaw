# Jarvis Vision

Status: product north star

Use this before product, UX, launch, pricing, onboarding, or strategy work. Do
not load it for unrelated implementation tasks.

## Promise

Jarvis is a local-first personal assistant/operator for Mac. The user talks to
Jarvis in Telegram, and Jarvis gets real computer work done across apps,
browser, files, email, messages, tools, memory, and workflows.

Jarvis should feel like delegating to a capable assistant who already works in
the user's real environment, not like managing infrastructure.

The core thesis: Jarvis is for messy digital life, not a coding workbench.
It packages cross-channel execution, memory, monitors, approvals, and guided
setup so users do not need to assemble agent infrastructure themselves.

Jarvis can use coding agents such as Codex- or Claude-like workers when that is
useful, but Jarvis itself should still feel assistant-first, not terminal-first.

## User

Jarvis starts with high-intent people who want leverage now: founders,
solo operators, solopreneurs, power users, and ambitious non-technical users
with many small digital tasks.

The strongest early user is a high-agency operator who owns their computer,
owns the risk, and wants more execution capacity without building a team,
learning developer concepts, or assembling a custom automation stack.

Useful shorthand:

> Jarvis is an Iron Man suit for one high-agency operator, not a company uniform
> for a committee.

Assistants, PA networks, and founder-led businesses are useful learning
surfaces, but the first wedge is not broad employee deployment or enterprise
workflow management. The product should make normal users feel oriented quickly
while still leaving power users room to go deeper.

Founder-led business workflow pilots are allowed when they teach repeatable
Jarvis product behavior. The best pilots are show-don't-tell demos of one
annoying real workflow, for example: given booking and passenger details, help
with airline check-in or seat selection, then stop for the human on CAPTCHA,
payment, purchase, passport-risk, or irreversible travel decisions. Treat these
as product discovery for packaged workflows, connectors, approvals, and proof —
not as bespoke client automation projects.

## Product Shape

- Mac-first execution. The user's Mac is the default working environment.
- Windows-aware business learning. Many business operators live on Windows, but
  that signal should inform packaged workflow and connector priorities before it
  pulls Jarvis away from the current Mac-first consumer wedge.
- Telegram-first control. Telegram is the current primary command and feedback
  surface.
- Local-first trust. Browser sessions, local files, installed tools, and machine
  context matter.
- Cross-channel operator surface. Email, messages, browser, files, and local
  tools should feel like one assistant surface, not disconnected automations.
- Packaged capability, not DIY infra. Memory, monitors, approvals, and guided
  setup are part of the product so the user does not have to wire an agent stack
  together by hand.
- Consumer-simple defaults. Advanced controls can exist, but they should not
  dominate the first experience.
- Proof over theory. Do not claim readiness without install, runtime, or
  user-visible behavior proof.

## Taste

- Subtract before adding.
- Prefer one clear path over many configurable options.
- Hide internal machinery unless the user needs it for recovery.
- Explain failures in plain language and give the smallest next action.
- Do not turn every useful idea into an active obligation.

## Non-Goals

- Do not make users choose local vs cloud per task.
- Do not make Linux VPS setup the default consumer story.
- Do not confuse Linux/server/API connector work with the Windows-native product
  question. Use server/API/MCP connectors when they make workflows repeatable;
  build Windows-native UX only after repeated demand proves the wedge.
- Do not expose runtime placement, ports, bundle IDs, or internal service names
  in primary consumer copy.
- Do not sell Artem as a custom automation agency. Jarvis is the product.
- Do not prematurely turn Jarvis into enterprise employee-control software with
  admin consoles, role-based access, procurement flows, audit theater, or
  self-hosted enterprise deployments before repeated real demand proves that
  market is worth pursuing.
- Do not keep permanent backlog docs in the active path.

## Trust Positioning

Security and trust matter, but the first trust story should be simple and
truthful:

- local-first Mac execution,
- open-source inspectability,
- user-owned environment,
- approval before external sends, purchases, payments, deletion, or other risky
  actions,
- clear proof/logs when Jarvis acts.

Do not lead with high-risk enterprise claims. If a prospect needs full
self-hosting, local-model infrastructure, admin controls, or procurement-grade
security review, they are probably not the current first ICP.

## Current Launch Bias

The current mission is trusted-tester learning: get the current Jarvis build into
real users' hands, observe first install/use friction, and fix only concrete
onboarding or package issues found by that feedback.

Broader public launch needs a deliberate identity/update-path decision, fuller
Sparkle update-cycle proof, and real tester feedback.
