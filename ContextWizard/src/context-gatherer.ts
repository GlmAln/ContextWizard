import { CompleteContext, ReviewComment, ProjectContext, PullRequestContext } from './types.js';
type ProbotEventContext = any;

async function getPackageJson(context: ProbotEventContext, headRef: string): Promise<any> {
    try {
        const pkg = await context.octokit.repos.getContent(
            context.repo({
                path: "package.json",
                ref: headRef,
            })
        );
        if ("content" in pkg.data) {
            return JSON.parse(
                Buffer.from(pkg.data.content, "base64").toString("utf-8")
            );
        }
    } catch (error) {
        console.log("package.json not found");
    }
    return null;
}

async function getLinkedIssues(context: ProbotEventContext, prBody: string | null): Promise<PullRequestContext['linkedIssues']> {
    const linkedIssues: PullRequestContext['linkedIssues'] = [];
    const issueNumbers = prBody?.match(/#(\d+)/g);

    if (issueNumbers) {
        // Limiter à 3 issues pour ne pas surcharger l'API ou le prompt LLM
        for (const issueRef of issueNumbers.slice(0, 3)) {
            const issueNumber = parseInt(issueRef.replace("#", ""));
            try {
                const issue = await context.octokit.issues.get(
                    context.repo({ issue_number: issueNumber })
                );
                linkedIssues.push({
                    number: issue.data.number,
                    title: issue.data.title,
                    body: issue.data.body,
                    labels: issue.data.labels,
                });
            } catch (error) {
                console.log(`Issue #${issueNumber} not found`);
            }
        }
    }
    return linkedIssues;
}

async function getFileContent(context: ProbotEventContext, path: string, headSha: string): Promise<string | null> {
    try {
        const afterFile = await context.octokit.repos.getContent(
            context.repo({
                path: path,
                ref: headSha,
            })
        );
        if ("content" in afterFile.data) {
            return Buffer.from(afterFile.data.content, "base64").toString("utf-8");
        }
    } catch (error) {
        console.log(`Could not fetch file content for ${path}`);
    }
    return null;
}

export async function gatherContext(context: ProbotEventContext, cleanedCommentBody: string): Promise<CompleteContext> {
    const { comment, pull_request, repository } = context.payload;

    const reviewComment: ReviewComment = {
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

    const projectContext: ProjectContext = {
        repoName: repository.name,
        repoFullName: repository.full_name,
        repoDescription: repository.description,
        repoLanguage: repository.language,
        repoTopics: repository.topics || [],
        defaultBranch: repository.default_branch,
        packageJson: packageJson,
    };

    const linkedIssues = await getLinkedIssues(context, pull_request.body);
    const prContext: PullRequestContext = {
        number: pull_request.number,
        title: pull_request.title,
        description: pull_request.body,
        state: pull_request.state,
        author: pull_request.user.login,
        createdAt: pull_request.created_at,
        baseBranch: pull_request.base.ref,
        headBranch: pull_request.head.ref,
        labels: pull_request.labels?.map((l: any) => l.name) || [],
        isDraft: pull_request.draft,
        linkedIssues: linkedIssues,
    };

    const allReviewComments = await context.octokit.pulls.listReviewComments(
        context.repo({ pull_number: pull_request.number })
    );

    const fileContentAfter = await getFileContent(context, comment.path, pull_request.head.sha);

    return {
        triggerComment: reviewComment,
        project: projectContext,
        pullRequest: prContext,
        conversation: {
            reviewComments: allReviewComments.data
                .filter((rc: any) => rc.id !== comment.id)
                .slice(0, 3)
                .map((rc: any) => ({
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