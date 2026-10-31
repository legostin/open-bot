---
name: teach-by-demo
description: Learn a browser task by watching the person do it, save it as a skill, run it later (also on a schedule) and repair it. Use when the person says "let me show you", "смотри как я делаю", "научу тебя", when a demonstration's recording arrives from the hub, when the hub says the person did the same thing several times, or when you run or fix a skill taught by the person.
---

# Learning from the person in the browser

The person can show you a task in the agents' browser instead of explaining it. The hub records what they do
(clicks, typing, pages; passwords and codes never), what they say while doing it, and the places they frame with
Highlight. You turn that into a skill: instructions you follow with understanding, not a replay of clicks.

## 1. Starting a demonstration

- The person offers to show, or you are stuck on a site: call `browser_teach` with `goal` in their words
  (`scope: "step"` for one step you could not do). Then tell them in one short sentence to go ahead, and wait: the
  live view is on their screen with control in their hands. Do not use the browser until the recording comes.
- The recording arrives as a hub message "[Browser] The person finished showing you…" with the steps and the files
  in your workspace (`downloads/rec-….md`, `.json`, `.jpg` pictures of what they framed). From the browser's own Teach
  button it comes without you asking first: then find out in one question what it was for.

## 2. Turning it into a skill

1. Retell what you saw in three to six short lines, in the person's language, as a colleague would ("Открываешь
   каталог, берёшь 19 л, ставишь количество, оформляешь на домашний адрес").
2. Ask only what is not clear, one question at a time, with quick replies (`show_choices`) where answers are short:
   what changes from time to time (the quantity, the address, the date) and what stays; what their words and
   highlights mean when that is not obvious ("самое дешёвое" — by price per litre or in total?).
3. For every step with consequences (marked "an action with consequences (browser_submit)": paying, ordering,
   sending, deleting) ask whether you may do it without asking next time, with the limit you saw ("Нажимать
   «Оформить заказ» без тебя, если сумма до 3 000 ₸?" — Да / Спрашивать каждый раз). Only what they agree to in
   their own words goes into `allow`; round a limit up only if they said so.
4. Call `hub_skill_save` with:
   - `name`: short, lowercase, words joined by `-` (`order-water-5vodi`); `description`: one line saying when to
     use it ("Заказать воду на 5vodi.kz: …"), in the person's language;
   - `instructions` (Markdown, English or the person's language), in this shape:

     ```
     # <Task>
     Site: <origin>. Taught by the person on <date>.
     ## Inputs
     - quantity: how many bottles (default 2; ask if they say otherwise) …
     ## Steps
     1. Open <url>. 2. Click link «Каталог». 3. Click button «Вода 19 л» … (exact names from the recording)
     ## Checks
     - Before paying, read «Итого» (the person pointed at it) and compare with the limit.
     ## With consequences
     - «Оформить заказ»: browser_submit with amount and currency; allowed without asking up to 3 000 ₸.
     ## When something differs
     - Ask the person to take over (or browser_teach scope step) instead of guessing; report what you saw.
     ```
   - `files`: the recording's files from your workspace; `sites`; `allow`: `[{site, label, maxAmount, currency}]`.
5. The person sees a card and taps to save; nothing is saved without it. After "saved", offer once to try it now,
   and if it is a regular thing, to put it on a schedule.

## 3. Running a taught skill

- Load it (`skill_load`), fill the inputs from what the person asked (ask for any you cannot know), then do the steps
  with the browser tools: snapshot, find the element by the name the skill gives (names may differ a little: a
  price inside a button's name changes), act, check what the skill says to check.
- A file field ("Chose the file … — an upload" in the recording): `browser_upload` with a file from your workspace. A
  photo or document the person sends in the chat is there (its path is in their message); ask for it when you have none.
  The person approves each upload on a card.
- When the person wants to see how it went, `browser_screenshot` with `share: true`, then `show_images` with the path.
- Steps with consequences always go through `browser_submit`, with `amount` and `currency` when money is spent: a
  limit approved ahead of time applies only then and only within it; otherwise the person gets a card.
- On a schedule: `trigger_create` with `skill` set to the skill's name and a prompt that says what to do ("Run the
  skill order-water-5vodi: 2 bottles to the home address"). Runs of a taught skill may click and type by themselves;
  anything with consequences still needs the approved limit or the person's tap.

## 4. Repairing it

- When you get stuck (the site changed, a captcha), ask the person to take over or call `browser_teach` with
  `scope: "step"`. What they did comes back with your next browser result ("While you waited, the person did…") or
  as a recording. Carry on with it.
- When the task is done, if the hint changed a step, offer to update the skill: `hub_skill_save` with `replaces` set
  to its name and the corrected instructions (the person confirms on the card again).

## 5. Routines the hub noticed

The hub may say "[Browser] The person did the same thing on <site> N times…". Offer in one short message with quick
replies to do it for them. Yes: `browser_journal export` the recordings it names and go on as in section 2. No:
`browser_journal dismiss` with the last recording's id, so it is not offered again.

## Privacy

What the person does in the browser stays on the hub for 30 days. "Забудь, что я делал в браузере сегодня" →
`browser_journal forget` with `day: "today"` (or `all`, or one `id`); say what was forgotten.
