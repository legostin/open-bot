import { describe, expect, it } from "vitest";
import { plainText, withBreaks } from "../ui/src/plain.ts";

describe("fact previews", () => {
  it("drop Markdown's marks and keep the words", () => {
    expect(plainText("# Профиль\n\nЗовут **Олег**, пишет на `TypeScript`.")).toBe("Профиль\nЗовут Олег, пишет на TypeScript.");
    expect(plainText("- кофе: *флэт уайт*\n- чай: __зелёный__\n1. раз\n2) два")).toBe("кофе: флэт уайт\nчай: зелёный\nраз\nдва");
    expect(plainText("> цитата\n\n---\n\n[сайт](https://example.com) и ![фото](a.png)")).toBe("цитата\nсайт и фото");
    expect(plainText("- [x] сделано\n- [ ] нет")).toBe("сделано\nнет");
    expect(plainText("```js\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("keep a note's single line breaks, but not inside code", () => {
    expect(withBreaks("Живёт в Алматы.\nЛюбит горы.\n\n- кофе\n- чай")).toBe("Живёт в Алматы.  \nЛюбит горы.\n\n- кофе  \n- чай");
    expect(withBreaks("```\na\nb\n```\nпосле")).toBe("```\na\nb\n```  \nпосле");
    expect(withBreaks("уже  \nтак")).toBe("уже  \nтак");
  });

  it("leave ordinary text alone", () => {
    expect(plainText("snake_case_name and 2*3*4, a - b")).toBe("snake_case_name and 2*3*4, a - b");
    expect(plainText("The user's sister Anna lives in Perm.")).toBe("The user's sister Anna lives in Perm.");
  });
});
