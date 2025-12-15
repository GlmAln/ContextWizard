// src/handlers.ts

import { Probot } from "probot";
import { gatherContext } from "./context-gatherer.js";
import { improveComment, postImprovedComment, summarizeReview } from "./core-logic.js";
import { CommentData, ReviewData } from "./types.js";

const triggerCommand = '/improve';
const summarizeCommand = "/summarize";

async function handleReviewCommentCreated(context: any) {
    console.log("🔔 Pull request review comment created event received");

    const { comment } = context.payload;

    if (comment.user.type === "Bot" ||
        comment.body.includes("🤖") ||
        !comment.body.toLowerCase().includes(triggerCommand)) {
        console.log("⏭️ Skipping comment (Bot or missing command).");
        return;
    }

    try {
        console.log(`Command '${triggerCommand}' detected. Starting processing...`);

        const cleanedBody = comment.body.replace(new RegExp(triggerCommand, 'gi'), '').trim();

        console.log("📥 Fetching complete context...");
        const completeContext = await gatherContext(context, cleanedBody);

        console.log("🧠 Sending to AI for improvement...");
        const improvedComment = await improveComment(completeContext);

        console.log("📤 Posting improved comment to GitHub...");
        const success = await postImprovedComment(
            context,
            improvedComment,
            completeContext.triggerComment.id
        );

        if (success) {
            console.log("✅ Process completed successfully!");
        }
    } catch (error) {
        console.error("❌ Error processing PR review comment:", error);
    }
}

async function handleReviewSubmitted(context: any) {
    console.log("📝 Pull request review submitted event received for summarization.");

    const { review, pull_request } = context.payload;

    if (!review.body || review.body.length < 5) {
        console.log("⏭️ Review body is empty or too short. Skipping summarization offer.");
        return;
    }

    try {
        const summaryOfferBody = `🤖 **ContextWizard Summary Offer**
The review by @${review.user.login} has been submitted. Would you like me to generate a concise summary of the key points and required changes?

Type \`${summarizeCommand}\` in a new general PR comment to get the AI-generated summary.`;

        await context.octokit.issues.createComment(
            context.issue({
                issue_number: pull_request.number,
                body: summaryOfferBody,
            })
        );

        console.log("✅ Summary offer posted to PR.");

    } catch (error) {
        console.error("❌ Error posting summary offer:", error);
    }
}

async function handleIssueCommentCreated(context: any) {
    const { comment, issue, pull_request } = context.payload;
    if (!issue.pull_request) {
        return;
    }

    if (comment.body.toLowerCase().includes(summarizeCommand)) {
        if (comment.user.type === "Bot" || comment.body.includes("🤖")) {
            console.log("⏭️ Skipping comment from bot.");
            return;
        }

        console.log(`🤖 Command '${summarizeCommand}' detected on PR #${issue.number}. Starting summary generation.`);

        try {
            const prNumber = issue.number;
            const allReviews = await context.octokit.pulls.listReviews(
                context.repo({ pull_number: prNumber })
            );
            const reviewsData: ReviewData[] = allReviews.data
                .map((r: any) => ({
                    author: r.user.login,
                    body: r.body,
                    state: r.state,
                    submittedAt: r.submitted_at,
                }))
                .filter((r: ReviewData) => r.state !== 'PENDING');

            const allComments = await context.octokit.pulls.listReviewComments(
                context.repo({ pull_number: prNumber })
            );

            const commentsData: CommentData[] = allComments.data.map((c: any) => ({
                author: c.user.login,
                body: c.body,
                path: c.path,
                line: c.line,
            }));

            const prContext = {
                number: pull_request.number,
                title: pull_request.title,
                description: pull_request.body,
                author: pull_request.user.login,
                baseBranch: pull_request.base.ref,
                headBranch: pull_request.head.ref,
            } as any;
            const summary = await summarizeReview(prContext, reviewsData, commentsData);
            const summaryBody = `🤖 **ContextWizard Review Summary**
Generated for PR #${prNumber} at the request of @${comment.user.login}.

${summary}

---
*This summary is AI-generated and should be verified for accuracy.*`;

            await context.octokit.issues.createComment(
                context.issue({
                    issue_number: prNumber,
                    body: summaryBody,
                })
            );

            console.log(`✅ Summary successfully posted for PR #${prNumber}.`);

        } catch (error: any) {
            console.error("❌ Error processing /summarize command:", error);
            await context.octokit.issues.createComment(
                context.issue({
                    body: `❌ **ContextWizard Error**\nI encountered an error while trying to generate the summary: \`${error.message}\``
                })
            );
        }
    }
}
export const setupHandlers = (app: Probot) => {
    app.on("pull_request_review_comment.created", handleReviewCommentCreated);
    app.on("pull_request_review.submitted", handleReviewSubmitted);
    app.on("issue_comment.created", handleIssueCommentCreated);
    app.on("issues.opened", async (context) => {
        const issueComment = context.issue({
            body: "Thanks for opening this issue!",
        });
        await context.octokit.issues.createComment(issueComment);
        console.log("Issue opened event received");
    });
};