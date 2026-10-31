// Alex in Lisbon. Every company, address and letter here is made up.

import type { Content } from "./types";

export const en: Content = {
  locale: "en",
  cast: {
    person: "Alex",
    team: {
      pio: { name: "Pio", description: "Your main assistant: answers at once and hands the rest to the team." },
      ada: { name: "Ada", description: "Mail and calendar: sorts letters, drafts replies, books meetings." },
      leo: { name: "Leo", description: "Research and the browser: finds, compares, keeps your channels." },
      bit: { name: "Bit", description: "Developer: works in your code on the MacBook." },
    },
    machines: { home: "Mac mini at home", laptop: "Alex’s MacBook Pro" },
  },
  history: {
    pio: [
      { role: "user", text: "Remind me to book the dentist next week", hoursAgo: 26 },
      { role: "assistant", text: "Done: Monday at 10:00 I’ll ask whether Tuesday or Thursday suits you better, and book it.", hoursAgo: 26 },
    ],
    ada: [
      { role: "assistant", text: "Yesterday’s mail is sorted: nothing urgent, two newsletters unsubscribed.", hoursAgo: 20 },
    ],
    leo: [
      { role: "user", text: "Find a good e-bike under €2,000", hoursAgo: 30 },
      { role: "assistant", text: "Three that fit: **Ampler Axel**, **VanMoof S5** used, **Cowboy Classic**. The Ampler wins on range and service in Lisbon.", hoursAgo: 30 },
    ],
    bit: [
      { role: "assistant", text: "The release branch builds again: the flaky upload test now waits for the file instead of sleeping.", hoursAgo: 22 },
    ],
  },
  ui: {
    demoNote: "In the demo, the script types for you",
    notInDemo: "That isn’t part of the demo",
  },
  chapters: {
    mail: {
      ask: "Go through my mail from this morning",
      query: "in:inbox newer_than:1d",
      found: "47 letters since 18:00 yesterday",
      reading: ["47 letters", "Anna’s letter", "the note from Finanças", "Marco’s letter", "Studio North’s invoice", "38 newsletters"],
      summary: [
        "**Done: 47 letters.**",
        "",
        "**Important**",
        "- **Anna, Studio North**: wants to move Thursday’s review to 15:00. I drafted a reply.",
        "- **Finanças**: the quarterly VAT return is due on the 20th. A reminder is set for the 17th.",
        "- **Marco, your landlord**: the boiler service is on Monday, 9–12.",
        "",
        "**To pay**: Studio North’s invoice, **€1,850** by November 15, added to your tasks.",
        "",
        "**Newsletters**: 38 archived, nothing worth reading today.",
        "",
        "Shall I answer Anna?",
      ].join("\n"),
      choices: ["Yes, show me the draft", "Later"],
    },
    send: {
      draftIntro: "Here it is:",
      draft: "> Hi Anna,\n>\n> Thursday at 15:00 works for me. I’ll bring the updated mockups.\n>\n> Best,\n> Alex",
      subject: "Re: Thursday review",
      to: "anna@studio-north.example",
      summary: "Send an email to anna@studio-north.example: “Re: Thursday review”",
      sent: "Sent. Anna usually answers within the hour; I’ll tell you when she does.",
      always: "Letters to Anna can go without asking",
      alwaysDone: "Done: letters to **anna@studio-north.example** go out without asking from now on. Everything else still waits for your yes.",
    },
  },
};
