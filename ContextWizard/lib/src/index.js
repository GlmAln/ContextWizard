import Perplexity from '@perplexity-ai/perplexity_ai';
import { GoogleGenAI } from "@google/genai";
// 1. Initialisation des clients LLM
// Assurez-vous que PERPLEXITY_API_KEY et GEMINI_API_KEY sont définies
const perplexityClient = new Perplexity({
    apiKey: process.env.PERPLEXITY_API_KEY || "",
});
const geminiClient = new GoogleGenAI({});
// Définir le fournisseur LLM par défaut ou à partir d'une variable d'environnement
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'perplexity';
console.log(`🧠 ContextWizard initialized with LLM Provider: ${LLM_PROVIDER}`);
// --- Fonctions d'appel d'API LLM spécifiques ---
async function callPerplexityAPI(systemPrompt, userPrompt) {
    const completion = await perplexityClient.chat.completions.create({
        model: 'sonar',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        max_tokens: 1500,
        temperature: 0.2,
        top_p: 0.9,
    });
    const rawContent = completion.choices?.[0]?.message?.content;
    // Logique d'extraction du contenu
    let improvedComment = "";
    if (typeof rawContent === "string") {
        improvedComment = rawContent;
    }
    else if (Array.isArray(rawContent)) {
        improvedComment = rawContent
            .map((chunk) => (chunk.text ?? chunk.content ?? chunk.body ?? String(chunk)))
            .join("");
    }
    else if (rawContent != null) {
        improvedComment = String(rawContent);
    }
    if (!improvedComment) {
        throw new Error("Empty response from Perplexity API");
    }
    return improvedComment;
}
/**
 * Appelle l'API Gemini. Utilise gemini-2.5-flash pour des raisons de quota et de rapidité.
 */
async function callGeminiAPI(systemPrompt, userPrompt) {
    const completion = await geminiClient.models.generateContent({
        // Modèle flash utilisé pour des quotas plus élevés et une faible latence
        model: 'gemini-2.5-flash',
        contents: [
            { role: "user", parts: [{ text: systemPrompt + "\n\n" + userPrompt }] },
        ],
        config: {
            maxOutputTokens: 1500,
            temperature: 0.2,
            topP: 0.9,
        }
    });
    const improvedComment = completion.text;
    if (!improvedComment) {
        throw new Error("Empty response from Gemini API");
    }
    return improvedComment;
}
// --- Fonction principale d'amélioration du commentaire (Orchestrateur) ---
async function improveComment(context) {
    const projectContext = context.project;
    const pullRequestContext = context.pullRequest;
    const triggerComment = context.triggerComment;
    // Le prompt système
    const systemPrompt = `You are a code review expert who transforms vague comments into clear, actionable feedback.

# PROJECT CONTEXT
Repository: ${projectContext.repoFullName}
Description: ${projectContext.repoDescription || "N/A"}
Primary Language: ${projectContext.repoLanguage || "N/A"}
${projectContext.packageJson ? `\nMain Dependencies: ${Object.keys(projectContext.packageJson.dependencies || {}).slice(0, 5).join(", ")}` : ""}

# PULL REQUEST CONTEXT
Title: ${pullRequestContext.title}
Description: ${pullRequestContext.description || "No description"}
Author: ${pullRequestContext.author}
Branch: ${pullRequestContext.headBranch} → ${pullRequestContext.baseBranch}
${pullRequestContext.linkedIssues.length > 0 ? `\nLinked Issues:\n${pullRequestContext.linkedIssues.map((i) => `- #${i.number}: ${i.title}`).join("\n")}` : ""}

# THE VAGUE COMMENT TO IMPROVE
Author: ${triggerComment.author}
File: ${triggerComment.path}
Line: ${triggerComment.line}
Original Comment: "${triggerComment.body}"

# CODE RELATED TO THE COMMENT
\`\`\`diff
${triggerComment.diffHunk}
\`\`\`

# FULL FILE (context)
${context.code.specificFile.after ? `\`\`\`\n${context.code.specificFile.after.slice(0, 3000)}\n\`\`\`` : "File not available"}

# OTHER REVIEW COMMENTS (for context)
${context.conversation.reviewComments.slice(0, 3).map((c) => `- ${c.author}: "${c.body}" (${c.path})`).join("\n")}`;
    // Le prompt utilisateur
    const userPrompt = `Improve this code review comment by:
1. Clearly explaining the identified problem
2. Providing technical context (performance, security, maintainability, etc.)
3. Proposing a concrete solution with code examples if relevant
4. Remaining constructive and friendly

If needed, research current best practices for ${projectContext.repoLanguage || "this language"} and ${triggerComment.path.split('.').pop() || "this file type"}.

IMPORTANT:
- Respond ONLY with the improved comment
- Use markdown for readability
- Include code examples between triple backticks if necessary
- Be concise but comprehensive (max 300 words)
- Keep a professional but friendly tone

Improved comment:`;
    try {
        console.log("🧠 Sending to AI for improvement... (" + LLM_PROVIDER + ")");
        let improvedComment;
        switch (LLM_PROVIDER.toLowerCase()) {
            case 'gemini':
            case 'google':
                improvedComment = await callGeminiAPI(systemPrompt, userPrompt);
                break;
            case 'perplexity':
                improvedComment = await callPerplexityAPI(systemPrompt, userPrompt);
                break;
            default:
                throw new Error(`Unsupported LLM Provider: ${LLM_PROVIDER}. Please set LLM_PROVIDER to 'gemini' or 'perplexity'.`);
        }
        return improvedComment;
    }
    catch (error) {
        console.error(`Error calling LLM provider (${LLM_PROVIDER}):`, error);
        throw error;
    }
}
// --- Fonctions utilitaires ---
async function postImprovedComment(context, improvedComment, originalCommentId) {
    try {
        // Post le commentaire AI comme une réponse au commentaire original
        await context.octokit.rest.pulls.createReplyForReviewComment(context.repo({
            pull_number: context.payload.pull_request.number,
            comment_id: originalCommentId,
            body: `🤖 **Improved Comment Suggestion** (AI-generated):\n\n${improvedComment}\n\n---\n*This comment was generated to clarify the feedback. Remember to **edit or accept/reject** this suggestion.*`,
        }));
        console.log(`✅ Improved comment posted as reply to comment ${originalCommentId}`);
        return true;
    }
    catch (error) {
        console.error("Error posting improved comment:", error);
        return false;
    }
}
async function gatherContext(context) {
    const { comment, pull_request, repository } = context.payload;
    const reviewComment = {
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
    const projectContext = {
        repoName: repository.name,
        repoFullName: repository.full_name,
        repoDescription: repository.description,
        repoLanguage: repository.language,
        repoTopics: repository.topics || [],
        defaultBranch: repository.default_branch,
    };
    let packageJson = null;
    try {
        const pkg = await context.octokit.repos.getContent(context.repo({
            path: "package.json",
            ref: pull_request.head.ref,
        }));
        if ("content" in pkg.data) {
            packageJson = JSON.parse(Buffer.from(pkg.data.content, "base64").toString("utf-8"));
        }
    }
    catch (error) {
        console.log("package.json not found");
    }
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
        linkedIssues: [],
    };
    const issueNumbers = prContext.description?.match(/#(\d+)/g);
    if (issueNumbers) {
        for (const issueRef of issueNumbers.slice(0, 3)) {
            const issueNumber = parseInt(issueRef.replace("#", ""));
            try {
                const issue = await context.octokit.issues.get(context.repo({
                    issue_number: issueNumber,
                }));
                prContext.linkedIssues.push({
                    number: issue.data.number,
                    title: issue.data.title,
                    body: issue.data.body,
                    labels: issue.data.labels,
                });
            }
            catch (error) {
                console.log(`Issue #${issueNumber} not found`);
            }
        }
    }
    const allReviewComments = await context.octokit.pulls.listReviewComments(context.repo({
        pull_number: pull_request.number,
    }));
    const fileContent = {
        path: comment.path,
        before: null,
        after: null,
    };
    try {
        const afterFile = await context.octokit.repos.getContent(context.repo({
            path: comment.path,
            ref: pull_request.head.sha,
        }));
        if ("content" in afterFile.data) {
            fileContent.after = Buffer.from(afterFile.data.content, "base64").toString("utf-8");
        }
    }
    catch (error) {
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
                .filter((rc) => rc.id !== comment.id)
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
            specificFile: fileContent,
        },
    };
}
// --- Enregistrement des gestionnaires d'événements Probot ---
export default (app) => {
    app.on("issues.opened", async (context) => {
        const issueComment = context.issue({
            body: "Thanks for opening this issue!",
        });
        await context.octokit.issues.createComment(issueComment);
        console.log("Issue opened event received");
    });
    // Gestionnaire pour l'amélioration des commentaires (FR4)
    app.on("pull_request_review_comment.created", async (context) => {
        console.log("🔔 Pull request review comment created event received");
        const { comment } = context.payload;
        const triggerCommand = '/improve';
        // Prévention de la boucle infinie du bot
        if (comment.user.type === "Bot" ||
            comment.body.includes("🤖") ||
            comment.body.includes("AI-generated") ||
            comment.body.includes("Improved Comment Suggestion")) {
            console.log("⏭️ Skipping comment from bot or containing bot markers.");
            return;
        }
        // Vérification de la commande /improve
        if (!comment.body.toLowerCase().includes(triggerCommand)) {
            console.log(`⏭️ Skipping comment. Must contain the '${triggerCommand}' command to trigger ContextWizard.`);
            return;
        }
        else {
            console.log(`Command '${triggerCommand}' detected. Starting processing...`);
        }
        // ⚠️ À PARTIR D'ICI, le code ne doit s'exécuter QUE si /improve est présent
        try {
            console.log(`Command '${triggerCommand}' detected. Starting processing...`);
            // Retirer la commande du corps avant de l'envoyer au LLM
            const cleanedBody = comment.body.replace(new RegExp(triggerCommand, 'gi'), '').trim();
            // IMPORTANT: Ne pas modifier comment.body directement, utilisez cleanedBody
            const modifiedComment = { ...comment, body: cleanedBody };
            console.log("📥 Fetching complete context...");
            const completeContext = await gatherContext(context);
            // Remplacer le body dans le contexte avec la version nettoyée
            completeContext.triggerComment.body = cleanedBody;
            console.log("🧠 Sending to AI for improvement...");
            const improvedComment = await improveComment(completeContext);
            console.log("📤 Posting improved comment to GitHub...");
            const success = await postImprovedComment(context, improvedComment, completeContext.triggerComment.id);
            if (success) {
                console.log("✅ Process completed successfully!");
            }
        }
        catch (error) {
            console.error("❌ Error processing PR review comment:", error);
            // Gestion d'erreur...
        }
    });
    // Nouveau gestionnaire pour la soumission d'une revue complète (FR6)
    app.on("pull_request_review.submitted", async (context) => {
        console.log("📝 Pull request review submitted event received for summarization.");
        const { review, pull_request } = context.payload;
        // Nous voulons seulement offrir un résumé si la revue contient un corps de texte
        if (!review.body || review.body.length < 5) {
            console.log("⏭️ Review body is empty or too short. Skipping summarization offer.");
            return;
        }
        // Offre la génération du résumé (l'utilisateur devra taper /summarize dans un commentaire PR général pour l'activer)
        try {
            const summaryOfferBody = `🤖 **ContextWizard Summary Offer**
[cite_start]The review by @${review.user.login} has been submitted. Would you like me to generate a concise summary of the key points and required changes? [cite: 67-72]

Type \`/summarize\` in a new general PR comment to get the AI-generated summary.`;
            await context.octokit.issues.createComment(context.issue({
                issue_number: pull_request.number,
                body: summaryOfferBody,
            }));
            console.log("✅ Summary offer posted to PR.");
        }
        catch (error) {
            console.error("❌ Error posting summary offer:", error);
        }
    });
    // Pour que le /summarize fonctionne, il doit être écouté sur issue_comment.created (commentaire général de PR)
    app.on("issue_comment.created", async (context) => {
        const { comment, issue } = context.payload;
        const summarizeCommand = "/summarize";
        // 1. Vérifie si le commentaire est sur une Pull Request (et non une simple Issue)
        if (!issue.pull_request) {
            return;
        }
        // 2. Vérifie la commande
        if (comment.body.toLowerCase().includes(summarizeCommand)) {
            console.log(`🤖 Command '${summarizeCommand}' detected on PR #${issue.number}. Starting summary generation.`);
            // Ici, vous devrez implémenter la logique de FR6.2 :
            // a) Fetcher toutes les revues et tous les commentaires de revue (pulls.listReviews + pulls.listReviewComments)
            // b) Concaténer le texte de la revue
            // c) Envoyer à l'IA avec un prompt pour résumer et créer une liste d'étapes exploitables (FR6.2)
            try {
                await context.octokit.issues.createComment(context.issue({
                    body: "💡 **Summary Generation Logic Needed:** I have detected the `/summarize` command. You still need to implement the full logic to fetch all reviews, send the data to the LLM for summarization (FR6.2), and post the result (FR6.3)."
                }));
            }
            catch (error) {
                console.error("Error posting summary placeholder:", error);
            }
        }
    });
};
