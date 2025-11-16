import { Probot } from "probot";
import Perplexity from '@perplexity-ai/perplexity_ai';

const perplexityClient = new Perplexity({
  apiKey: process.env.PERPLEXITY_API_KEY || "",
});

// Type definitions for better type safety
interface ReviewComment {
  body: string;
  author: string;
  createdAt: string;
  path: string;
  line: number | null;
  position: number | null;
  diffHunk: string;
  commitId: string;
  id: number;
}

interface ProjectContext {
  repoName: string;
  repoFullName: string;
  repoDescription: string | null;
  repoLanguage: string | null;
  repoTopics: string[];
  defaultBranch: string;
  packageJson: any;
}

interface PullRequestContext {
  number: number;
  title: string;
  description: string | null;
  state: string;
  author: string;
  createdAt: string;
  baseBranch: string;
  headBranch: string;
  labels: string[];
  isDraft: boolean;
  linkedIssues: any[];
}

interface CompleteContext {
  triggerComment: ReviewComment;
  project: ProjectContext;
  pullRequest: PullRequestContext;
  conversation: {
    reviewComments: any[];
  };
  code: {
    specificFile: {
      path: string;
      before: string | null;
      after: string | null;
    };
  };
}

async function improveComment(context: CompleteContext): Promise<string> {
  const systemPrompt = `You are a code review expert who transforms vague comments into clear, actionable feedback.

# PROJECT CONTEXT
Repository: ${context.project.repoFullName}
Description: ${context.project.repoDescription || "N/A"}
Primary Language: ${context.project.repoLanguage || "N/A"}
${context.project.packageJson ? `\nMain Dependencies: ${Object.keys(context.project.packageJson.dependencies || {}).slice(0, 5).join(", ")}` : ""}

# PULL REQUEST CONTEXT
Title: ${context.pullRequest.title}
Description: ${context.pullRequest.description || "No description"}
Author: ${context.pullRequest.author}
Branch: ${context.pullRequest.headBranch} → ${context.pullRequest.baseBranch}
${context.pullRequest.linkedIssues.length > 0 ? `\nLinked Issues:\n${context.pullRequest.linkedIssues.map((i: any) => `- #${i.number}: ${i.title}`).join("\n")}` : ""}

# THE VAGUE COMMENT TO IMPROVE
Author: ${context.triggerComment.author}
File: ${context.triggerComment.path}
Line: ${context.triggerComment.line}
Original Comment: "${context.triggerComment.body}"

# CODE RELATED TO THE COMMENT
\`\`\`diff
${context.triggerComment.diffHunk}
\`\`\`

# FULL FILE (context)
${context.code.specificFile.after ? `\`\`\`\n${context.code.specificFile.after.slice(0, 3000)}\n\`\`\`` : "File not available"}

# OTHER REVIEW COMMENTS (for context)
${context.conversation.reviewComments.slice(0, 3).map((c: any) => `- ${c.author}: "${c.body}" (${c.path})`).join("\n")}`;

  const userPrompt = `Improve this code review comment by:
1. Clearly explaining the identified problem
2. Providing technical context (performance, security, maintainability, etc.)
3. Proposing a concrete solution with code examples if relevant
4. Remaining constructive and friendly

If needed, research current best practices for ${context.project.repoLanguage || "this language"} and ${context.triggerComment.path.split('.').pop() || "this file type"}.

IMPORTANT:
- Respond ONLY with the improved comment
- Use markdown for readability
- Include code examples between triple backticks if necessary
- Be concise but comprehensive (max 300 words)
- Keep a professional but friendly tone

Improved comment:`;

  try {
    const completion = await perplexityClient.chat.completions.create({
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      max_tokens: 1500,
      temperature: 0.2,
      top_p: 0.9,
    });

    const rawContent = completion.choices?.[0]?.message?.content;
    let improvedComment: string = "";

    if (typeof rawContent === "string") {
      improvedComment = rawContent;
    } else if (Array.isArray(rawContent)) {
      improvedComment = rawContent
        .map((chunk: any) => {
          if (typeof chunk === "string") return chunk;
          if (chunk && typeof chunk === "object") {
            return (chunk.text ?? chunk.content ?? chunk.body ?? JSON.stringify(chunk));
          }
          return String(chunk);
        })
        .join("");
    } else if (rawContent != null) {
      improvedComment = String(rawContent);
    }

    if (!improvedComment) {
      throw new Error("Empty response from Perplexity API");
    }

    return improvedComment;
  } catch (error) {
    console.error("Error calling Perplexity API:", error);
    throw error;
  }
}

async function postImprovedComment(
  context: any,
  improvedComment: string,
  originalCommentId: number
): Promise<boolean> {
  try {
    await context.octokit.rest.pulls.createReplyForReviewComment(
      context.repo({
        pull_number: context.payload.pull_request.number,
        comment_id: originalCommentId,
        body: `🤖 **Improved Comment Suggestion** (AI-generated):\n\n${improvedComment}\n\n---\n*This comment was automatically generated to clarify code review feedback.*`,
      })
    );

    console.log(`✅ Improved comment posted as reply to comment ${originalCommentId}`);
    return true;
  } catch (error) {
    console.error("Error posting improved comment:", error);

    try {
      await context.octokit.rest.issues.createComment(
        context.issue({
          body: `🤖 **Improved Comment Suggestion** for [this comment](https://github.com/${context.payload.repository.full_name}/pull/${context.payload.pull_request.number}#discussion_r${originalCommentId}):\n\n${improvedComment}\n\n---\n*This comment was automatically generated to clarify code review feedback.*`,
        })
      );
      console.log("✅ Improved comment posted as general PR comment (fallback)");
      return true;
    } catch (fallbackError) {
      console.error("Error posting fallback comment:", fallbackError);
      return false;
    }
  }
}

async function gatherContext(context: any): Promise<CompleteContext> {
  const { comment, pull_request, repository } = context.payload;

  const reviewComment: ReviewComment = {
    body: comment.body,
    author: comment.user.login,
    createdAt: comment.created_at,
    path: comment.path,
    line: comment.line,
    position: comment.position,
    diffHunk: comment.diff_hunk,
    commitId: comment.commit_id,
    id: comment.id,
  };

  const projectContext: Omit<ProjectContext, 'packageJson'> = {
    repoName: repository.name,
    repoFullName: repository.full_name,
    repoDescription: repository.description,
    repoLanguage: repository.language,
    repoTopics: repository.topics || [],
    defaultBranch: repository.default_branch,
  };

  let packageJson = null;
  try {
    const pkg = await context.octokit.repos.getContent(
      context.repo({
        path: "package.json",
        ref: pull_request.head.ref,
      })
    );
    if ("content" in pkg.data) {
      packageJson = JSON.parse(
        Buffer.from(pkg.data.content, "base64").toString("utf-8")
      );
    }
  } catch (error) {
    console.log("package.json not found");
  }

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
    linkedIssues: [],
  };

  const issueNumbers = prContext.description?.match(/#(\d+)/g);
  if (issueNumbers) {
    for (const issueRef of issueNumbers.slice(0, 3)) {
      const issueNumber = parseInt(issueRef.replace("#", ""));
      try {
        const issue = await context.octokit.issues.get(
          context.repo({
            issue_number: issueNumber,
          })
        );
        prContext.linkedIssues.push({
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

  const allReviewComments = await context.octokit.pulls.listReviewComments(
    context.repo({
      pull_number: pull_request.number,
    })
  );

  const fileContent = {
    path: comment.path,
    before: null as string | null,
    after: null as string | null,
  };

  try {
    const afterFile = await context.octokit.repos.getContent(
      context.repo({
        path: comment.path,
        ref: pull_request.head.sha,
      })
    );
    if ("content" in afterFile.data) {
      fileContent.after = Buffer.from(
        afterFile.data.content,
        "base64"
      ).toString("utf-8");
    }
  } catch (error) {
    console.log("Could not fetch file content");
  }

  return {
    triggerComment: reviewComment,
    project: {
      ...projectContext,
      packageJson: packageJson,
    },
    pullRequest: prContext,
    conversation: {
      reviewComments: allReviewComments.data
        .filter((rc: any) => rc.id !== comment.id)
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
      specificFile: fileContent,
    },
  };
}

export default (app: Probot) => {
  app.on("issues.opened", async (context) => {
    const issueComment = context.issue({
      body: "Thanks for opening this issue!",
    });
    await context.octokit.issues.createComment(issueComment);
    console.log("Issue opened event received");
  });

  app.on("pull_request_review_comment.created", async (context) => {
    console.log("🔔 Pull request review comment created event received");

    const { comment } = context.payload;

    // ===================================================
    // CRITICAL: Prevent infinite loop by ignoring bot comments
    // ===================================================
    // Check if the comment author is a bot
    if (comment.user.type === "Bot") {
      console.log("⏭️ Skipping comment from bot user:", comment.user.login);
      return;
    }

    // 2. Check if it's the GitHub Actions bot or the app itself
    const botUsernames = [
      "github-actions[bot]",
      process.env.GITHUB_APP_NAME, // Your app's username
      "bot",
    ].filter(Boolean);

    if (botUsernames.some(botName => comment.user.login.toLowerCase().includes(botName?.toLowerCase() || ""))) {
      console.log("⏭️ Skipping comment from known bot:", comment.user.login);
      return;
    }

    // 3. Check if comment contains bot markers
    if (comment.body.includes("🤖") ||
      comment.body.includes("AI-generated") ||
      comment.body.includes("Improved Comment Suggestion")) {
      console.log("⏭️ Skipping bot-generated comment");
      return;
    }

    // Additional check: ignore comments that look like bot-generated responses
    if (comment.body.includes("🤖") || comment.body.includes("AI-generated")) {
      console.log("⏭️ Skipping bot-generated comment");
      return;
    }

    // Optional: Only process comments that contain a trigger keyword
    // Uncomment this if you want to activate the bot only when someone uses a specific command
    // if (!comment.body.includes("/improve") && !comment.body.includes("@bot-name")) {
    //   console.log("⏭️ Comment doesn't contain trigger keyword");
    //   return;
    // }

    try {
      console.log("📥 Fetching complete context...");
      const completeContext = await gatherContext(context);

      console.log("🧠 Sending to Perplexity for improvement...");
      const improvedComment = await improveComment(completeContext);
      console.log("✨ Improved comment received:", improvedComment.slice(0, 100) + "...");

      console.log("📤 Posting improved comment to GitHub...");
      const success = await postImprovedComment(
        context,
        improvedComment,
        completeContext.triggerComment.id
      );

      if (success) {
        console.log("✅ Process completed successfully!");
      } else {
        console.log("⚠️ Process completed with warnings");
      }
    } catch (error) {
      console.error("❌ Error processing PR review comment:", error);

      try {
        await context.octokit.issues.createComment(
          context.issue({
            body: `🤖 An error occurred while processing the review comment.\n\nError: ${error instanceof Error ? error.message : "Unknown error"}`,
          })
        );
      } catch (commentError) {
        console.error("Could not post error comment:", commentError);
      }
    }
  });
};
