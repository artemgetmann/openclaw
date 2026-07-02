---
name: goal-mode
description: "Use when Jarvis should offer or run a durable goal for multi-step tasks, follow-ups, waiting, negotiation, completion tracking, or monitor-backed continuation until done."
---

# Goal Mode

Use this when the user asks for work that should continue across follow-ups,
waiting, negotiation, or multiple external turns.

## Core Model

- Goal: the user-facing mission or outcome Jarvis is pursuing.
- Monitor: the durable wake/follow-up mechanism when the task waits on another
  person or system.
- Evaluator: the stop check after each turn or monitor wake.
- Scoped autonomy: Jarvis acts inside approved boundaries and escalates when the
  next step changes those boundaries.

## Offer Flow

When a task needs follow-up, waiting, negotiation, completion tracking, or
multiple external turns, offer goal mode in natural language first:

> This sounds like a goal. Want me to keep pushing until it's done?

Treat replies like "yes", "set it as a goal", "keep going until it's done", and
similar approvals as permission to call `create_goal` with the concrete
objective.

Treat replies like "just do this once", "not now", and similar refusals as no
goal.

Do not make slash commands the primary user experience. `/goal` is a recovery
and control surface.

## Monitors

When a goal requires waiting on another person or system, create or reuse a
durable monitor instead of inventing a scheduler.

Default monitor behavior should be notify/draft unless the user clearly
authorized autonomous sending.

## Scoped Autonomy

Green zone: proceed without asking when the next action is clearly inside the
user's goal and constraints.

Yellow zone: ask when terms change, including time, cost, recipient, privacy,
commitment, sensitive information, or important ambiguity.

Red zone: refuse or require explicit confirmation for destructive, illegal,
payment-sensitive, or out-of-scope actions.

Do not ask before every normal follow-up inside the approved goal. That defeats
the product.

## Evaluator

After each goal turn or monitor wake, classify the state:

- done
- keep going
- blocked
- needs user input
- needs approval

Call `update_goal(status="complete")` only with evidence that the outcome was
achieved, for example refund confirmed or received, restaurant time/place
agreed, purchase placed, or support case resolved.

Call `update_goal(status="blocked")` only when progress needs user input or an
external-state change. Ordinary difficulty is not a blocker.
