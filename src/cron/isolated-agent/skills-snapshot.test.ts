import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCronSkillsSnapshot } from "./skills-snapshot.js";

describe("resolveCronSkillsSnapshot", () => {
  it.each(["message-drafting", "wacli"])(
    "keeps personal tone available to autonomous runs filtered to %s",
    (selectedSkill) => {
      const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cron-skills-"));
      const snapshot = resolveCronSkillsSnapshot({
        workspaceDir,
        config: {
          agents: {
            list: [{ id: "monitor-worker", skills: [selectedSkill] }],
          },
        },
        agentId: "monitor-worker",
        isFastTestEnv: false,
      });

      expect(snapshot.prompt).toContain("<name>message-drafting</name>");
      expect(snapshot.prompt).toContain("<name>personal-tone-of-voice</name>");
      expect(snapshot.skills.map((skill) => skill.name)).toContain("personal-tone-of-voice");
      expect(snapshot.skillFilter).toEqual([selectedSkill]);
    },
  );
});
