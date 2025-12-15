async function getPackageJson(context, headRef) {
    try {
        const pkg = await context.octokit.repos.getContent(context.repo({
            path: "package.json",
            ref: headRef,
        }));
        if ("content" in pkg.data) {
            return JSON.parse(Buffer.from(pkg.data.content, "base64").toString("utf-8"));
        }
    }
    catch (error) {
        console.log("package.json not found");
    }
    return null;
}
async function getLinkedIssues(context, prBody) {
    const linkedIssues = [];
    const issueNumbers = prBody?.match(/#(\d+)/g);
    if (issueNumbers) {
        // Limiter à 3 issues pour ne pas surcharger l'API ou le prompt LLM
        for (const issueRef of issueNumbers.slice(0, 3)) {
            const issueNumber = parseInt(issueRef.replace("#", ""));
            try {
                const issue = await context.octokit.issues.get(context.repo({ issue_number: issueNumber }));
                linkedIssues.push({
                    number: issue.data.number,
                    title: issue.data.title,
                    body: issue.data.body || "",
                    labels: issue.data.labels,
                });
            }
            catch (error) {
                console.log(`Issue #${issueNumber} not found`);
            }
        }
    }
    return linkedIssues;
}
async function getFileContent(context, path, headSha) {
    try {
        const afterFile = await context.octokit.repos.getContent(context.repo({
            path: path,
            ref: headSha,
        }));
        if ("content" in afterFile.data) {
            return Buffer.from(afterFile.data.content, "base64").toString("utf-8");
        }
    }
    catch (error) {
        console.log(`Could not fetch file content for ${path}`);
    }
    return null;
}
export async function gatherContext(context, cleanedCommentBody) {
    const { comment, pull_request, repository } = context.payload;
    const reviewComment = {
        body: cleanedCommentBody,
        author: comment.user.login,
        createdAt: comment.created_at,
        path: comment.path,
        line: comment.line,
        position: comment.position,
        diffHunk: comment.diff_hunk,
        commitId: comment.commit_id,
        id: comment.id,
    };
    const packageJson = await getPackageJson(context, pull_request.head.ref);
    const projectContext = {
        repoName: repository.name,
        repoFullName: repository.full_name,
        repoDescription: repository.description,
        repoLanguage: repository.language,
        repoTopics: repository.topics || [],
        defaultBranch: repository.default_branch,
        packageJson: packageJson,
    };
    const linkedIssues = await getLinkedIssues(context, pull_request.body);
    const prContext = {
        number: pull_request.number,
        title: pull_request.title,
        description: pull_request.body,
        state: pull_request.state,
        author: pull_request.user.login,
        createdAt: pull_request.created_at,
        baseBranch: pull_request.base.ref,
        headBranch: pull_request.head.ref,
        labels: pull_request.labels?.map((l) => l.name) || [],
        isDraft: pull_request.draft,
        linkedIssues: linkedIssues,
    };
    const allReviewComments = await context.octokit.pulls.listReviewComments(context.repo({ pull_number: pull_request.number }));
    const fileContentAfter = await getFileContent(context, comment.path, pull_request.head.sha);
    return {
        triggerComment: reviewComment,
        project: projectContext,
        pullRequest: prContext,
        conversation: {
            reviewComments: allReviewComments.data
                .filter((rc) => rc.id !== comment.id)
                .slice(0, 3)
                .map((rc) => ({
                author: rc.user.login,
                body: rc.body,
                path: rc.path,
                line: rc.line,
                diffHunk: rc.diff_hunk,
                createdAt: rc.created_at,
            })),
        },
        code: {
            specificFile: {
                path: comment.path,
                before: null,
                after: fileContentAfter ? fileContentAfter.slice(0, 3000) : null,
            },
        },
    };
}
export async function getPullRequestDiff(context, prNumber) {
    try {
        const response = await context.octokit.pulls.get(context.repo({
            pull_number: prNumber,
            headers: {
                accept: 'application/vnd.github.v3.diff',
            },
        }));
        if (typeof response.data === 'string' && response.data.length > 50) {
            return response.data.slice(0, 15000);
        }
        if (response.status === 200 && response.data) {
            console.warn("PR Diff retrieved, but not as a string. Check GitHub App permissions.");
            const files = await context.octokit.pulls.listFiles(context.repo({ pull_number: prNumber }));
            const combinedDiff = files.data.map((f) => f.patch || '').join('\n');
            if (combinedDiff.length > 50) {
                console.log("Successfully combined diff from file patches.");
                return combinedDiff.slice(0, 15000);
            }
        }
    }
    catch (error) {
        console.error("Critical error fetching PR diff:", error);
    }
    return "Diff not available.";
}
