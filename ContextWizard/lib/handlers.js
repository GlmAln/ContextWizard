// src/handlers.ts
import { gatherContext, getPullRequestDiff } from "./context-gatherer.js";
import { improveComment, postImprovedComment, summarizeReview, generateCandidateReviews, classifyComment } from "./core-logic.js";
const triggerCommand = '/improve';
const summarizeCommand = "/summarize";
const wizardReviewCommand = "/wizard-review";
async function handleReviewCommentCreated(context) {
    console.log("🔔 Pull request review comment created event received (for automatic categorization).");
    const { comment } = context.payload;
    if (comment.user.type === "Bot" || comment.body.includes("🤖")) {
        console.log("⏭️ Skipping comment from bot or containing bot markers.");
        return;
    }
    try {
        const originalBody = comment.body;
        if (originalBody.toLowerCase().includes(triggerCommand)) {
            console.log(`Command '${triggerCommand}' detected. Running EXPLICIT improvement flow...`);
            const cleanedBody = originalBody.replace(new RegExp(triggerCommand, 'gi'), '').trim();
            const completeContext = await gatherContext(context, cleanedBody);
            const improvedComment = await improveComment(completeContext);
            await postImprovedComment(context, improvedComment, completeContext.triggerComment.id);
            return;
        }
        console.log("📥 Fetching context for automatic categorization...");
        const completeContext = await gatherContext(context, originalBody);
        console.log("🧠 Step 1: Sending to AI for Classification...");
        const classification = await classifyComment(completeContext);
        console.log(`🧠 Step 2: Classified as '${classification.category}', Action: '${classification.action}'`);
        let improvedComment = null;
        switch (classification.action) {
            case 'do_nothing':
                console.log("⏭️ Action 'do_nothing' (Praise or Clear Question). Skipping reply.");
                return;
            case 'clarify':
                console.log("🧠 Step 3: Clarifying the ambiguous question (Action: CLARIFY)...");
                improvedComment = await improveComment(completeContext);
                break;
            case 'suggest_code':
                console.log("🧠 Step 3: Generating code suggestion for clear change (Action: SUGGEST CODE)...");
                improvedComment = await improveComment(completeContext);
                break;
            case 'clarify_suggest_code':
                console.log("🧠 Step 3: Clarifying and suggesting code for ambiguous change (Action: CLARIFY & SUGGEST CODE)...");
                improvedComment = await improveComment(completeContext);
                break;
            default:
                console.warn(`Unknown action type: ${classification.action}. Skipping.`);
                return;
        }
        if (improvedComment) {
            console.log("📤 Posting AI action (Clarification/Suggestion) to GitHub...");
            await postImprovedComment(context, improvedComment, completeContext.triggerComment.id);
        }
    }
    catch (error) {
        console.error("❌ Error processing PR review comment:", error);
    }
}
// --- DÉCLARATION DE LA FONCTION MANQUANTE (handleReviewSubmitted) ---
async function handleReviewSubmitted(context) {
    console.log("📝 Pull request review submitted event received for summarization.");
    const { review, pull_request } = context.payload;
    // Vérification: Si la revue contient un corps de texte non vide pour justifier l'offre
    if (!review.body || review.body.length < 5) {
        console.log("⏭️ Review body is empty or too short. Skipping summarization offer.");
        return;
    }
    try {
        // FR6.1: Le système offre de générer un résumé après une revue complète
        const summaryOfferBody = `🤖 **ContextWizard Summary Offer**
The review by @${review.user.login} has been submitted. Would you like me to generate a concise summary of the key points and required changes?

Type \`${summarizeCommand}\` in a new general PR comment to get the AI-generated summary.`;
        await context.octokit.issues.createComment(context.issue({
            issue_number: pull_request.number,
            body: summaryOfferBody,
        }));
        console.log("✅ Summary offer posted to PR.");
    }
    catch (error) {
        console.error("❌ Error posting summary offer:", error);
    }
}
// ----------------------------------------------------------------------
async function handleIssueCommentCreated(context) {
    const { comment, issue } = context.payload;
    console.log(`💬 Issue comment created for #${issue.number}. Body starts with: ${comment.body.substring(0, 30)}...`);
    // Vérifie si le commentaire est sur une Pull Request
    if (!issue.pull_request) {
        console.log("⏭️ Skipping issue comment: not linked to a PR.");
        return;
    }
    if (comment.user.type === "Bot" || comment.body.includes("🤖")) {
        console.log("⏭️ Skipping comment from bot.");
        return;
    }
    const body = comment.body.toLowerCase();
    const prNumber = issue.number;
    // --- 1. Gérer la commande /summarize (FR6) ---
    if (body.includes(summarizeCommand)) {
        console.log(`🤖 Command '${summarizeCommand}' detected on PR #${prNumber}. Starting summary generation.`);
        try {
            const prResponse = await context.octokit.pulls.get(context.repo({ pull_number: prNumber }));
            const prDetails = prResponse.data;
            const allReviews = await context.octokit.pulls.listReviews(context.repo({ pull_number: prNumber }));
            const reviewsData = allReviews.data
                .map((r) => ({
                author: r.user.login,
                body: r.body,
                state: r.state,
                submittedAt: r.submitted_at,
            }))
                .filter((r) => r.state !== 'PENDING');
            const allComments = await context.octokit.pulls.listReviewComments(context.repo({ pull_number: prNumber }));
            const commentsData = allComments.data.map((c) => ({
                author: c.user.login,
                body: c.body,
                path: c.path,
                line: c.line,
            }));
            const prContext = {
                number: prDetails.number,
                title: prDetails.title,
                description: prDetails.body,
                author: prDetails.user.login,
                baseBranch: prDetails.base.ref,
                headBranch: prDetails.head.ref,
            };
            const summary = await summarizeReview(prContext, reviewsData, commentsData);
            const summaryBody = `🤖 **ContextWizard Review Summary**
Generated for PR #${prNumber} at the request of @${comment.user.login}.

${summary}

---
*This summary is AI-generated and should be verified for accuracy.*`;
            await context.octokit.issues.createComment(context.issue({
                issue_number: prNumber,
                body: summaryBody,
            }));
            console.log(`✅ Summary successfully posted for PR #${prNumber}.`);
        }
        catch (error) {
            console.error("❌ Error processing /summarize command:", error);
            await context.octokit.issues.createComment(context.issue({
                body: `❌ **ContextWizard Error**\nI encountered an error while trying to generate the summary: \`${error.message}\`. Please check logs.`
            }));
        }
    }
    // --- 2. Gérer la commande /wizard-review (FR5) ---
    else if (body.includes(wizardReviewCommand)) {
        console.log(`🧙 Command '${wizardReviewCommand}' detected on PR #${prNumber}. Starting candidate generation.`);
        try {
            const prResponse = await context.octokit.pulls.get(context.repo({ pull_number: prNumber }));
            const prDetails = prResponse.data;
            const fullDiff = await getPullRequestDiff(context, prNumber);
            const prContext = {
                number: prDetails.number,
                title: prDetails.title,
                description: prDetails.body,
                author: prDetails.user.login,
                baseBranch: prDetails.base.ref,
                headBranch: prDetails.head.ref,
            };
            const candidates = await generateCandidateReviews(prContext, fullDiff);
            let output = `## 🧙 ContextWizard Review Suggestions
Generated for PR #${prNumber} at the request of @${comment.user.login}.

Here are ${candidates.length} potential review comments based on analyzing the PR diff. **The system shall never post them automatically.** Review them, and if they are valid, post them as inline comments!

| File:Line | Category | Title | Suggested Action (Excerpt) |\n| :--- | :--- | :--- | :--- |\n`;
            candidates.forEach((c) => {
                const escapedDescription = c.description.replace(/\|/g, '\\|').replace(/\n/g, ' ').substring(0, 100) + '...';
                output += `| \`${c.path}:${c.line}\` | **${c.technicalCategory}** | ${c.title} | ${escapedDescription} |\n`;
            });
            output += `\n---
*To post one of these suggestions, copy the full content of the \`description\` and post it as an inline comment at the specified line number (\`File:Line\`).*`;
            await context.octokit.issues.createComment(context.issue({
                issue_number: prNumber,
                body: output,
            }));
            console.log(`✅ Candidate review comments posted successfully for PR #${prNumber}.`);
        }
        catch (error) {
            console.error("❌ Error processing /wizard-review command:", error);
            await context.octokit.issues.createComment(context.issue({
                body: `❌ **ContextWizard Error**\nI encountered an error while generating wizard suggestions: \`${error.message}\`. This often occurs when the diff is too large or the AI fails to generate valid JSON. Please check logs.`
            }));
        }
    }
}
export const setupHandlers = (app) => {
    app.on("pull_request_review_comment.created", handleReviewCommentCreated);
    app.on("pull_request_review.submitted", handleReviewSubmitted); // <-- MAINTENANT DÉCLARÉE
    app.on("issue_comment.created", handleIssueCommentCreated);
    app.on("issues.opened", async (context) => {
        const issueComment = context.issue({
            body: "Thanks for opening this issue!",
        });
        await context.octokit.issues.createComment(issueComment);
        console.log("Issue opened event received");
    });
};
