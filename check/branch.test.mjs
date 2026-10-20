/**
 * The default branch check, against a GitHub API that answers from memory.
 * Run with `node --test check/`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultBranchChecker } from "./branch.mjs";

const HEAD = "a".repeat(40);
const COMMIT = "b".repeat(40);

/**
 * A GitHub API whose answers `routes` maps by path; any other path is a 404.
 * Every path asked is kept in `asked`.
 */
function fakeApi(routes) {
  const asked = [];
  async function githubApi(path) {
    asked.push(path);
    const answer = routes[path];
    if (answer === undefined) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    const { status = 200, body } = answer;
    return Response.json(body, { status });
  }
  return { githubApi, asked };
}

function repository(overrides = {}) {
  return {
    "/repos/example/plugin": { body: { default_branch: "main" } },
    "/repos/example/plugin/branches/main": {
      body: { name: "main", commit: { sha: HEAD } },
    },
    [`/repos/example/plugin/compare/${HEAD}...${COMMIT}?per_page=1`]: {
      body: { status: "behind" },
    },
    ...overrides,
  };
}

describe("defaultBranchChecker", () => {
  it("compares the branch's head commit with the commit, not the branch's name", async () => {
    // A tag named main, which a comparison by name could resolve instead.
    const { githubApi, asked } = fakeApi(
      repository({
        [`/repos/example/plugin/compare/main...${COMMIT}?per_page=1`]: {
          body: { status: "behind" },
        },
      }),
    );
    const defaultBranchHas = defaultBranchChecker(githubApi);

    assert.deepEqual(await defaultBranchHas("example", "plugin", COMMIT), {
      branch: "main",
      has: true,
    });
    assert.deepEqual(asked, [
      "/repos/example/plugin",
      "/repos/example/plugin/branches/main",
      `/repos/example/plugin/compare/${HEAD}...${COMMIT}?per_page=1`,
    ]);
  });

  it("finds the commit on the branch when it is the head", async () => {
    const { githubApi } = fakeApi(
      repository({
        [`/repos/example/plugin/compare/${HEAD}...${COMMIT}?per_page=1`]: {
          body: { status: "identical" },
        },
      }),
    );

    const answer = await defaultBranchChecker(githubApi)(
      "example",
      "plugin",
      COMMIT,
    );
    assert.equal(answer.has, true);
  });

  for (const status of ["ahead", "diverged"]) {
    it(`does not find a commit the branch is ${status} of`, async () => {
      const { githubApi } = fakeApi(
        repository({
          [`/repos/example/plugin/compare/${HEAD}...${COMMIT}?per_page=1`]: {
            body: { status },
          },
        }),
      );

      assert.deepEqual(
        await defaultBranchChecker(githubApi)("example", "plugin", COMMIT),
        { branch: "main", has: false },
      );
    });
  }

  it("does not find a commit GitHub does not know", async () => {
    const { githubApi } = fakeApi(
      repository({
        [`/repos/example/plugin/compare/${HEAD}...${COMMIT}?per_page=1`]:
          undefined,
      }),
    );

    assert.deepEqual(
      await defaultBranchChecker(githubApi)("example", "plugin", COMMIT),
      { branch: "main", has: false },
    );
  });

  it("reads the default branch once and its head every time", async () => {
    const { githubApi, asked } = fakeApi(repository());
    const defaultBranchHas = defaultBranchChecker(githubApi);

    await defaultBranchHas("example", "plugin", COMMIT);
    await defaultBranchHas("example", "plugin", COMMIT);
    assert.equal(
      asked.filter((path) => path === "/repos/example/plugin").length,
      1,
    );
    assert.equal(
      asked.filter((path) => path === "/repos/example/plugin/branches/main")
        .length,
      2,
    );
  });

  it("reads a default branch with a slash in its name", async () => {
    const { githubApi } = fakeApi(
      repository({
        "/repos/example/plugin": { body: { default_branch: "release/1" } },
        "/repos/example/plugin/branches/release%2F1": {
          body: { name: "release/1", commit: { sha: HEAD } },
        },
      }),
    );

    assert.deepEqual(
      await defaultBranchChecker(githubApi)("example", "plugin", COMMIT),
      { branch: "release/1", has: true },
    );
  });

  it("fails when GitHub does not answer for the branch", async () => {
    const { githubApi } = fakeApi(
      repository({ "/repos/example/plugin/branches/main": undefined }),
    );

    await assert.rejects(
      defaultBranchChecker(githubApi)("example", "plugin", COMMIT),
      { message: "GitHub answered 404 for the branch main of example/plugin." },
    );
  });

  for (const sha of [undefined, "", "main", "A".repeat(40), `${HEAD}/x`]) {
    it(`fails when GitHub names ${JSON.stringify(sha)} as the branch's head`, async () => {
      const { githubApi, asked } = fakeApi(
        repository({
          "/repos/example/plugin/branches/main": {
            body: { name: "main", commit: { sha } },
          },
        }),
      );

      await assert.rejects(
        defaultBranchChecker(githubApi)("example", "plugin", COMMIT),
        {
          message:
            "GitHub names no head commit for the branch main of example/plugin.",
        },
      );
      assert.ok(!asked.some((path) => path.includes("/compare/")));
    });
  }

  it("fails when GitHub names no default branch", async () => {
    const { githubApi } = fakeApi(
      repository({ "/repos/example/plugin": { body: {} } }),
    );

    await assert.rejects(
      defaultBranchChecker(githubApi)("example", "plugin", COMMIT),
      { message: "GitHub names no default branch for example/plugin." },
    );
  });

  it("fails when the comparison answers with an error", async () => {
    const { githubApi } = fakeApi(
      repository({
        [`/repos/example/plugin/compare/${HEAD}...${COMMIT}?per_page=1`]: {
          status: 500,
          body: {},
        },
      }),
    );

    await assert.rejects(
      defaultBranchChecker(githubApi)("example", "plugin", COMMIT),
      {
        message: `GitHub answered 500 comparing main with ${COMMIT} in example/plugin.`,
      },
    );
  });
});
