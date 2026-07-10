---
name: find-food
description: "Help choose what to eat, pick from a menu or menu photo, find a restaurant or cafe nearby, compare delivery options, or choose a meal within dietary, budget, time, energy, comfort, or work-venue constraints. Use for requests such as 'what should I eat?', 'help me choose from this menu', 'find food near me', or 'compare these delivery options'."
metadata: { "openclaw": { "emoji": "🍽️", "displayName": "Find Something to Eat" } }
---

# Find Something to Eat

Make the decision easy. Return one best choice and at most two useful
alternatives instead of a large option dump.

## Decide

1. Identify the user's goal from the request and visible context: energy,
   comfort, speed, budget, dietary fit, or a place to work. Ask only questions
   that block a safe, useful recommendation.
2. Apply the user's own visible profile, memory, and preferences when available.
   Prefer the current request and current evidence over older preferences. Do
   not invent personal defaults.
3. Confirm allergies or dietary restrictions when they are unknown and could
   materially affect the choice.
4. For "near me," use a live location, shared pin, or an explicitly stated
   current area. Never treat a home, shipping address, saved base, or old trip
   location as the user's current location. Ask for the current area if it
   cannot be derived safely.
5. For place discovery, follow the bundled `goplaces` skill and use its managed
   `skills/goplaces/scripts/goplaces-search.sh` wrapper first when available.
   For a specific Google Maps place or link, inspect its in-place Menu tab or
   readable menu photos when prices or dish selection matter; do not rely only
   on web snippets or Places metadata. Distinguish the evidence source and say
   when an API result contains place metadata but no current menu. Use current
   browser or menu evidence when opening hours, availability, delivery fees, or
   item details matter. State when information may be stale or incomplete.
6. For menus or menu photos, extract only serious candidates, respect the
   user's constraints, and compare the likely real total. Include tax, service,
   delivery, packaging, and platform fees when visible; otherwise label the
   total as an estimate and name the missing fees.
7. Show the local currency. Also show the user's preferred comparison currency
   when it is known and useful, using a current or clearly labeled rough
   exchange rate.
8. Recommend the best option decisively. Explain the fit in one or two concrete
   reasons, then give up to two alternatives only when they offer a meaningful
   tradeoff.

## Output

Lead with `Best pick:` and include:

- the dish, restaurant, or cafe
- the estimated real total and relevant currencies
- why it best matches the user's goal
- one short uncertainty note when evidence is incomplete
- up to two alternatives with a clear tradeoff, if useful

If nothing meets the constraints, say so plainly and recommend the smallest
constraint to relax.

## Approval Boundary

Do not place, send, submit, or change an order or cart without the user's
explicit confirmation of the exact choice and known total. Research, compare,
and draft first; stop before the external action.
