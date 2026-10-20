import { COMMIT_PATTERN } from "./listing.mjs";

/**
 * Whether a commit is on a repository's default branch, asked of the GitHub
 * API through `githubApi`, which takes a path and answers as `fetch` does.
 * The default branch of each repository asked about is read once.
 *
 * @param {(path: string) => Promise<Response>} githubApi
 * @returns {(owner: string, repo: string, commit: string) => Promise<{ branch: string, has: boolean }>}
 */
export function defaultBranchChecker(githubApi) {
  const defaultBranches = new Map();

  /**
   * By GitHub's comparison of the branch's head with the commit: `identical`
   * or `behind` when the branch contains it. The head is read from the branch
   * first and compared by its commit id, because a bare name in a comparison
   * is a ref GitHub resolves, and a tag of the same name could stand in for
   * the branch. A commit GitHub does not know is not on it.
   */
  return async function defaultBranchHas(owner, repo, commit) {
    const repository = `${owner}/${repo}`;
    let branch = defaultBranches.get(repository);
    if (branch === undefined) {
      const response = await githubApi(`/repos/${repository}`);
      if (!response.ok) {
        throw new Error(
          `GitHub answered ${String(response.status)} for the repository ${repository}.`,
        );
      }
      branch = (await response.json()).default_branch;
      if (typeof branch !== "string" || branch === "") {
        throw new Error(`GitHub names no default branch for ${repository}.`);
      }
      defaultBranches.set(repository, branch);
    }

    const branchResponse = await githubApi(
      `/repos/${repository}/branches/${encodeURIComponent(branch)}`,
    );
    if (!branchResponse.ok) {
      throw new Error(
        `GitHub answered ${String(branchResponse.status)} for the branch ${branch} of ${repository}.`,
      );
    }
    const head = (await branchResponse.json()).commit?.sha;
    if (typeof head !== "string" || !COMMIT_PATTERN.test(head)) {
      throw new Error(
        `GitHub names no head commit for the branch ${branch} of ${repository}.`,
      );
    }

    const response = await githubApi(
      `/repos/${repository}/compare/${head}...${commit}?per_page=1`,
    );
    if (response.status === 404) {
      return { branch, has: false };
    }
    if (!response.ok) {
      throw new Error(
        `GitHub answered ${String(response.status)} comparing ${branch} with ${commit} in ${repository}.`,
      );
    }
    const { status } = await response.json();
    return { branch, has: status === "identical" || status === "behind" };
  };
}
