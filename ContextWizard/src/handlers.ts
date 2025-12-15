import { Probot } from "probot";
import { gatherContext, getPullRequestDiff } from "./context-gatherer.js";
import { improveComment, postImprovedComment, summarizeReview, generateCandidateReviews } from "./core-logic.js";
import { CommentData, ReviewData, CandidateReviewComment } from "./types.js";

const triggerCommand = '/improve';
const summarizeCommand = "/summarize";
const wizardReviewCommand = "/wizard-review";

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

        // Nettoyer la commande pour ne pas la transmettre au LLM
        const cleanedBody = comment.body.replace(new RegExp(triggerCommand, 'gi'), '').trim();

        console.log("📥 Fetching complete context...");
        // gatherContext inclut la logique pour FR3.2 (Documentation)
        const completeContext = await gatherContext(context, cleanedBody);

        console.log("🧠 Sending to AI for improvement...");
        const improvedComment = await improveComment(completeContext);

        console.log("📤 Posting improved comment to GitHub...");
        // FR4.2: Le bot poste une suggestion, l'utilisateur doit accepter/éditer
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
        // FR6.1: Le système offre de générer un résumé après une revue complète
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
            // Correction: Fetcher la PR complète car 'pull_request' n'est pas complet dans ce payload
            const prResponse = await context.octokit.pulls.get(
                context.repo({ pull_number: prNumber })
            );
            const prDetails = prResponse.data;

            // Récupération de toutes les données nécessaires
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
                number: prDetails.number,
                title: prDetails.title,
                description: prDetails.body,
                author: prDetails.user.login,
                baseBranch: prDetails.base.ref,
                headBranch: prDetails.head.ref,
            } as any;

            // Appel au LLM pour la synthèse (FR6.2)
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
                    body: `❌ **ContextWizard Error**\nI encountered an error while trying to generate the summary: \`${error.message}\`. Please check logs.`
                })
            );
        }
    }
    // --- 2. Gérer la commande /wizard-review (FR5) ---
    else if (body.includes(wizardReviewCommand)) {

        console.log(`🧙 Command '${wizardReviewCommand}' detected on PR #${prNumber}. Starting candidate generation.`);

        try {
            // Récupérer les détails complets de la PR
            const prResponse = await context.octokit.pulls.get(
                context.repo({ pull_number: prNumber })
            );
            const prDetails = prResponse.data;

            // Récupérer le diff complet de la PR
            const fullDiff = await getPullRequestDiff(context, prNumber);

            // Créer l'objet PR Context
            const prContext = {
                number: prDetails.number,
                title: prDetails.title,
                description: prDetails.body,
                author: prDetails.user.login,
                baseBranch: prDetails.base.ref,
                headBranch: prDetails.head.ref,
            } as any;

            // Générer les commentaires candidats (FR5.2)
            const candidates = await generateCandidateReviews(prContext, fullDiff);

            // --- Post du Résultat (FR5.3) ---
            let output = `## 🧙 ContextWizard Review Suggestions
Generated for PR #${prNumber} at the request of @${comment.user.login}.

Here are ${candidates.length} potential review comments based on analyzing the PR diff. **The system shall never post them automatically.** Review them, and if they are valid, post them as inline comments!

| File:Line | Category | Title | Suggested Action (Excerpt) |\n| :--- | :--- | :--- | :--- |\n`;

            candidates.forEach((c: CandidateReviewComment) => {
                // Échapper les barres verticales et limiter la longueur pour le tableau
                const escapedDescription = c.description.replace(/\|/g, '\\|').replace(/\n/g, ' ').substring(0, 100) + '...';
                output += `| \`${c.path}:${c.line}\` | **${c.technicalCategory}** | ${c.title} | ${escapedDescription} |\n`;
            });

            output += `\n---
*To post one of these suggestions, copy the full content of the \`description\` and post it as an inline comment at the specified line number (\`File:Line\`).*`;

            await context.octokit.issues.createComment(
                context.issue({
                    issue_number: prNumber,
                    body: output,
                })
            );

            console.log(`✅ Candidate review comments posted successfully for PR #${prNumber}.`);

        } catch (error: any) {
            console.error("❌ Error processing /wizard-review command:", error);
            await context.octokit.issues.createComment(
                context.issue({
                    body: `❌ **ContextWizard Error**\nI encountered an error while generating wizard suggestions: \`${error.message}\`. This often occurs when the diff is too large or the AI fails to generate valid JSON. Please check logs.`
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