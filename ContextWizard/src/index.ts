import { Probot } from "probot";

export default (app: Probot) => {
  app.on("issues.opened", async (context) => {
    const issueComment = context.issue({
      body: "Thanks for opening this issue!",
    });
    await context.octokit.issues.createComment(issueComment);
    console.log("Issue opened event received");
  });

  app.on('pull_request_review_comment.created', async (context) => {
    const { comment, pull_request, repository } = context.payload;

    // 1. Le commentaire qui a déclenché l'event
    const reviewComment = comment.body;

    // 2. Récupérer TOUS les commentaires de conversation
    const conversationComments = await context.octokit.issues.listComments(
      context.repo({
        issue_number: pull_request.number
      })
    );

    // 3. Récupérer TOUS les review comments (sur le code)
    const reviewComments = await context.octokit.pulls.listReviewComments(
      context.repo({
        pull_number: pull_request.number
      })
    );

    // 4. Title et description de la PR
    const prTitle = pull_request.title;
    const prDescription = pull_request.body;

    // 5. Récupérer le diff complet du code
    const prDiff = await context.octokit.pulls.get(
      context.repo({
        pull_number: pull_request.number,
        mediaType: {
          format: 'diff'
        }
      })
    );

    // 6. Récupérer la liste des fichiers modifiés avec détails
    const files = await context.octokit.pulls.listFiles(
      context.repo({
        pull_number: pull_request.number
      })
    );

    // Envoyer tout ça à ton backend pour traitement IA
    console.log({
      reviewComment,
      conversationComments: conversationComments.data,
      reviewComments: reviewComments.data,
      prTitle,
      prDescription,
      prDiff: prDiff.data,
      files: files.data
    });
  });
};
