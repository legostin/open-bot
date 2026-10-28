// Pure helpers of capture and recall: word stems across inflection, the secret and sensitivity guards, ranking.
import { describe, expect, it } from "vitest";
import { headline, looksSensitive, overlap, secretReason, stem, stems } from "../server/text.ts";
import { rank } from "../server/recall.ts";
import { newFact, parseFact, serializeFact } from "../server/store.ts";

describe("stems", () => {
  it("survive inflection in Russian and English", () => {
    const same = (a: string, b: string) => expect(stem(a), `${a} / ${b}`).toBe(stem(b));
    same("Казань", "Казани");
    same("Казань", "Казанью");
    same("Анна", "Анне");
    same("Москва", "Москве");
    same("велосипед", "велосипедом");
    same("пользователь", "пользователя");
    same("users", "user");
    same("coffees", "coffee");
    expect(stem("Perm")).toBe("perm");
    expect(stem("2026")).toBe("2026");
  });

  it("drop stop words and keep content", () => {
    expect(stems("The user is in the city of Perm, and he likes it")).toEqual(["city", "perm", "likes"].map((w) => stem(w)));
    expect(stems("Что подарить Анне на день рождения?")).toEqual(["подарить", "анн", "ден", "рожден"].map((w) => stem(w)));
    expect(overlap(stems("The user lives in Perm"), stems("the user lives in Perm."))).toBe(1);
  });

  it("make short titles", () => {
    expect(headline("The user lives in Perm. He moved there in October.")).toBe("The user lives in Perm");
    expect(headline("A".repeat(50) + " " + "B".repeat(50), 60)).toBe("A".repeat(50) + "…");
  });
});

describe("guards", () => {
  it("know secrets", () => {
    for (const s of [
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrSt",
      "my password is hunter2!",
      "Пароль от почты: qwerty123",
      "card 4111 1111 1111 1111",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "AKIAIOSFODNN7EXAMPLE",
      "seed phrase: apple banana …",
      "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5",
    ]) {
      expect(secretReason(s), s).toBeDefined();
    }
    for (const s of ["The user's bank login is vault://bank-login", "The user's phone ends in 4411", "Born on 1990-03-03", "Passport photo needs renewal soon"]) {
      expect(secretReason(s), s).toBeUndefined();
    }
  });

  it("know sensitive matters, and not ordinary ones", () => {
    for (const s of ["The user has type 2 diabetes", "У Олега аллергия на пенициллин", "Ипотека в Сбере до 2040 года", "The user's salary is 5000", "Болеет гриппом", "His passport number is in the drawer"]) {
      expect(looksSensitive(s), s).toBe(true);
    }
    for (const s of ["Долго искал квартиру в Перми", "Работает над операционной системой", "The user likes long walks", "Любит раков? Нет, раковины в ванной"]) {
      expect(looksSensitive(s), s).toBe(false);
    }
  });
});

describe("ranking", () => {
  const fact = (path: string, body: string, more: Partial<Parameters<typeof newFact>[0]> = {}) => newFact({ path, title: headline(body), body, ...more });
  const facts = [
    fact("people/anna.md", "Анна — сестра пользователя, тренирует велосипедистов.", { kind: "person", about: ["Анна"] }),
    fact("projects/atlas.md", "Atlas is the user's analytics service.", { kind: "project", about: ["Atlas"], importance: 4 }),
    fact("notes/old.md", "The user once visited Atlas mountains.", { kind: "note", importance: 1, updated: "2020-01-01T00:00:00.000Z" }),
    fact("notes/mine.md", "Ada's private note about Atlas.", { scope: "agent:ada" }),
    fact("you/kazan.md", "The user lived in Kazan.", { kind: "self", status: "archived" }),
  ];

  it("ranks by relevance, then importance and recency; hides what is not true now or not yours", () => {
    const bob = rank(facts, "How is Atlas going?", { agentId: "bob" }).map((s) => s.fact.path);
    expect(bob[0]).toBe("projects/atlas.md");
    expect(bob).not.toContain("notes/mine.md");
    expect(rank(facts, "Atlas", { agentId: "ada" }).map((s) => s.fact.path)).toContain("notes/mine.md");
    // The more important, newer fact comes before the old trivia that mentions the same word.
    expect(rank(facts, "Atlas", { agentId: "bob" }).map((s) => s.fact.path)).toEqual(["projects/atlas.md", "notes/old.md"]);
    expect(rank(facts, "Как дела у Анны?")[0].fact.path).toBe("people/anna.md");
    expect(rank(facts, "Kazan")).toEqual([]);
    expect(rank(facts, "Kazan", { includeArchived: true })[0].fact.path).toBe("you/kazan.md");
    expect(rank(facts, "weather today")).toEqual([]);
  });

  it("round-trips a fact through its file", () => {
    const f = fact("you/x.md", "The user lives in Perm.", { kind: "self", about: ["Perm"], slot: "home city", validFrom: "2026-10-20", sources: [{ agent: "ada", conversation: "c_1", at: "2026-10-29T00:00:00.000Z", quote: "I moved: to Perm" }], extra: { mood: "ok" } });
    const back = parseFact("you/x.md", serializeFact(f));
    expect(back).toEqual({ ...f, source: "" });
  });
});
