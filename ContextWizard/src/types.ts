export interface ReviewComment {
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

export interface ProjectContext {
    repoName: string;
    repoFullName: string;
    repoDescription: string | null;
    repoLanguage: string | null;
    repoTopics: string[];
    defaultBranch: string;
    packageJson: any;
}

export interface PullRequestContext {
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
    linkedIssues: Array<{
        number: number;
        title: string;
        body: string | null;
        labels: any;
    }>;
}

export interface CompleteContext {
    triggerComment: ReviewComment;
    project: ProjectContext;
    pullRequest: PullRequestContext;
    conversation: {
        reviewComments: Array<{
            author: string;
            body: string;
            path: string;
            line: number | null;
            diffHunk: string;
            createdAt: string;
        }>;
    };
    code: {
        specificFile: {
            path: string;
            before: string | null;
            after: string | null;
        };
    };
}

export interface ReviewData {
    author: string;
    body: string | null;
    state: 'APPROVED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
    submittedAt: string;
}

export interface CommentData {
    author: string;
    body: string;
    path: string;
    line: number | null;
}

export interface CandidateReviewComment {
    path: string;
    line: number;
    title: string;
    description: string;
    technicalCategory: 'Performance' | 'Security' | 'Maintainability' | 'Style' | 'Bug Potential';
}