import { CandidateReviewComment, CategorizedAction, CommentData, CompleteContext, PullRequestContext, ReviewData, } from "./types.js";
import { callPerplexityAPI, callGeminiAPI, LLM_PROVIDER } from './llm-clients.js';

export async function classifyComment(context: CompleteContext): Promise<CategorizedAction> {
    const triggerComment = context.triggerComment;
    const systemPrompt = `You are an AI code review triage expert. Analyze the following human review comment based on the full context provided.

# Comment to Analyze: "${triggerComment.body}"

# Task:
1. Categorize the comment into one of: 'praise', 'question', 'change', or 'ambiguous'.
2. If the category is 'question' or 'change', determine if the comment is 'clear and actionable' (isClear: true) or 'vague/ambiguous' (isClear: false).
3. Determine the required action based on the categorization and clarity.

# Instructions for JSON Output:
Your response MUST be ONLY a JSON object conforming to the CategorizedAction interface.
interface CategorizedAction {
    category: 'praise' | 'question' | 'change' | 'ambiguous';
    isClear: boolean;
    action: 'suggest_code' | 'clarify' | 'clarify_suggest_code' | 'do_nothing';
    explanation: string;
}

Action Mapping:
- Praise/Ambiguous: action must be 'do_nothing'.
- Change (Clear): action must be 'suggest_code' (propose example code).
- Change (Ambiguous): action must be 'clarify_suggest_code' (rewrite + suggest code).
- Question (Clear): action must be 'do_nothing'.
- Question (Ambiguous): action must be 'clarify' (rewrite the question).
`;

    const rawResponse = await callGeminiAPI(systemPrompt, "Categorize and determine the action now.");

    return JSON.parse(rawResponse) as CategorizedAction;
}

function buildSystemPrompt(context: CompleteContext): string {
    const projectContext = context.project;
    const pullRequestContext = context.pullRequest;
    const triggerComment = context.triggerComment;

    const pkgDependencies = projectContext.packageJson
        ? Object.keys(projectContext.packageJson.dependencies || {}).slice(0, 5).join(", ")
        : "N/A";

    const linkedIssues = pullRequestContext.linkedIssues.length > 0
        ? `\nLinked Issues:\n${pullRequestContext.linkedIssues.map((i) => `- #${i.number}: ${i.title}`).join("\n")}`
        : "";

    const otherComments = context.conversation.reviewComments.length > 0
        ? context.conversation.reviewComments.map((c) => `- ${c.author}: "${c.body}" (${c.path})`).join("\n")
        : "None";

    return `You are a code review expert who transforms vague comments into clear, actionable feedback.

# PROJECT CONTEXT
Repository: ${projectContext.repoFullName}
Description: ${projectContext.repoDescription || "N/A"}
Primary Language: ${projectContext.repoLanguage || "N/A"}
Main Dependencies: ${pkgDependencies}

# PULL REQUEST CONTEXT
Title: ${pullRequestContext.title}
Description: ${pullRequestContext.description || "No description"}
Author: ${pullRequestContext.author}
Branch: ${pullRequestContext.headBranch} → ${pullRequestContext.baseBranch}
${linkedIssues}

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
${context.code.specificFile.after ? `\`\`\`\n${context.code.specificFile.after}\n\`\`\`` : "File content not available"}

# OTHER REVIEW COMMENTS (for context)
${otherComments}`;
}

function buildUserPrompt(context: CompleteContext): string {
    const language = context.project.repoLanguage || "this language";
    const fileType = context.triggerComment.path.split('.').pop() || "this file type";

    return `Improve this code review comment by:
1. Clearly explaining the identified problem
2. Providing technical context (performance, security, maintainability, etc.)
3. Proposing a concrete solution with code examples if relevant
4. Remaining constructive and friendly

If needed, research current best practices for ${language} and ${fileType}.

IMPORTANT:
- Respond ONLY with the improved comment
- Use markdown for readability
- Include code examples between triple backticks if necessary
- Be concise but comprehensive (max 300 words)
- Keep a professional but friendly tone

Improved comment:`;
}

export async function improveComment(context: CompleteContext): Promise<string> {
    const systemPrompt = buildSystemPrompt(context);
    const userPrompt = buildUserPrompt(context);

    console.log("🧠 Sending to AI for improvement... (" + LLM_PROVIDER + ")");

    let improvedComment: string;
    try {
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
    } catch (error) {
        console.error(`Error calling LLM provider (${LLM_PROVIDER}):`, error);
        throw error;
    }
}

export async function postImprovedComment(
    context: any,
    improvedComment: string,
    originalCommentId: number
): Promise<boolean> {
    try {
        await context.octokit.rest.pulls.createReplyForReviewComment(
            context.repo({
                pull_number: context.payload.pull_request.number,
                comment_id: originalCommentId,
                body: `🤖 **Improved Comment Suggestion** (AI-generated):\n\n${improvedComment}\n\n---\n*This comment was generated to clarify the feedback. Remember to **edit or accept/reject** this suggestion.*`,
            })
        );

        console.log(`✅ Improved comment posted as reply to comment ${originalCommentId}`);
        return true;
    } catch (error) {
        console.error("Error posting improved comment:", error);
        return false;
    }
}

function buildSummaryPrompt(prContext: PullRequestContext, reviews: ReviewData[], comments: CommentData[]): { system: string, user: string } {
    const prDetails = `
# PULL REQUEST CONTEXT
Title: ${prContext.title}
Description: ${prContext.description || "No description"}
Author: ${prContext.author}
Branch: ${prContext.headBranch} → ${prContext.baseBranch}
`;

    const reviewBodies = reviews
        .filter(r => r.body)
        .map((r, index) => `## REVIEW ${index + 1} by @${r.author} (State: ${r.state})\n${r.body}`)
        .join('\n\n---\n');
    const inlineComments = comments
        .map(c => `- [${c.path}:${c.line || 'N/A'}] @${c.author}: "${c.body.substring(0, 150)}..."`)
        .join('\n');

    const systemPrompt = `You are an expert technical assistant specializing in summarizing code review discussions. Your goal is to provide a neutral, constructive, and highly actionable summary of a Pull Request review conversation.

# INSTRUCTIONS
1. Analyze the following Pull Request details, full review bodies, and inline comments.
2. Synthesize the feedback into two distinct, concise sections.
3. The response MUST be ONLY the markdown content for the summary.

${prDetails}

# FULL REVIEW BODIES
${reviewBodies || "No full review bodies submitted."}

# INLINE CODE COMMENTS (Actionable Feedback)
${inlineComments || "No inline comments posted."}
`;

    const userPrompt = `Generate the final summary using the following structure.

Structure:
## 💡 Key Review Points
A bulleted list of the main technical, architectural, or design concerns raised. Max 3-5 points.

## 🛠️ Actionable Next Steps
A numbered list of concrete changes the Pull Request author must perform to address the feedback. Refer to specific files or concepts if possible.

Summary:`;

    return { system: systemPrompt, user: userPrompt };
}

export async function summarizeReview(
    prContext: PullRequestContext,
    reviews: ReviewData[],
    comments: CommentData[]
): Promise<string> {
    const { system: systemPrompt, user: userPrompt } = buildSummaryPrompt(prContext, reviews, comments);

    console.log("🧠 Sending review data to AI for summarization... (" + LLM_PROVIDER + ")");

    let summary: string;
    try {
        switch (LLM_PROVIDER.toLowerCase()) {
            case 'gemini':
            case 'google':
                summary = await callGeminiAPI(systemPrompt, userPrompt);
                break;
            case 'perplexity':
                summary = await callPerplexityAPI(systemPrompt, userPrompt);
                break;
            default:
                throw new Error(`Unsupported LLM Provider: ${LLM_PROVIDER}`);
        }

        return summary;
    } catch (error) {
        console.error(`Error calling LLM provider (${LLM_PROVIDER}) for summary:`, error);
        throw error;
    }
}

export async function generateCandidateReviews(
    prContext: PullRequestContext,
    fullDiff: string
): Promise<CandidateReviewComment[]> {
    const systemPrompt = `You are a static analysis tool integrated with a Code Review AI, specialized in finding subtle issues in a diff.

Your task is to analyze the provided Git diff for a Pull Request and identify 3 to 5 high-value issues (bugs, performance bottlenecks, maintainability risks, security concerns, or poor style).

# CONTEXT
PR Title: ${prContext.title}
PR Author: ${prContext.author}
Target Branch: ${prContext.baseBranch}

# DIFF TO ANALYZE
\`\`\`diff
${fullDiff}
\`\`\`

# INSTRUCTIONS
1. Analyze the diff and find significant issues.
2. For each issue, identify the exact file (\`path\`) and the most relevant line number (\`line\`) where the issue occurs in the new code.
3. Your final output MUST be a JSON array that strictly conforms to the TypeScript interface CandidateReviewComment.
4. DO NOT include any text, markdown, or explanation outside of the JSON block.

JSON Structure Interface:
interface CandidateReviewComment {
    path: string;
    line: number;
    title: string;
    description: string;
    technicalCategory: 'Performance' | 'Security' | 'Maintainability' | 'Style' | 'Bug Potential';
}

The resulting JSON array must be parsable without errors.`;

    const userPrompt = "Analyze the diff and generate the JSON array of candidate review comments now.";

    console.log("🧠 Sending full diff to AI for candidate review generation... (" + LLM_PROVIDER + ")");

    let rawResponse: string;
    try {
        rawResponse = await callGeminiAPI(systemPrompt, userPrompt);
    } catch (error) {
        console.warn(`Gemini failed or is unavailable for JSON generation. Falling back to Perplexity.`);
        rawResponse = await callPerplexityAPI(systemPrompt, userPrompt);
    }

    try {
        const jsonMatch = rawResponse.match(/```json\n([\s\S]*?)\n```/i) || rawResponse.match(/\[[\s\S]*?\]/);

        let jsonString = jsonMatch ? jsonMatch[1] || jsonMatch[0] : rawResponse;

        jsonString = jsonString.trim();
        if (!jsonString.startsWith('[')) jsonString = '[' + jsonString;
        if (!jsonString.endsWith(']')) jsonString = jsonString + ']';

        const candidates: CandidateReviewComment[] = JSON.parse(jsonString);
        console.log(`✅ Successfully parsed ${candidates.length} candidate comments.`);
        return candidates;

    } catch (e) {
        console.error("Error parsing JSON response from LLM:", e);
        throw new Error("AI returned a non-parsable JSON structure for candidate comments. Raw: " + rawResponse.substring(0, 200) + '...');
    }
}