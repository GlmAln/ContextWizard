# ContextWizard – Getting Started (Existing GitHub App + Local Probot)

ContextWizard uses an existing GitHub App  
👉 https://github.com/apps/contextwizard  

This guide shows how to:

1. Install the ContextWizard GitHub App on **your repository**
2. Run the **Probot backend locally** so it can process review comments
3. Start using ContextWizard in your pull requests

---

## 1. Install the ContextWizard GitHub App on your repo

1. Open the app page in your browser:  
   https://github.com/apps/contextwizard

2. Click **Configure** (top right).

3. Under **Repository access**:
   - Choose **Only select repositories**.
   - Select the repository (or repositories) where you want to use ContextWizard.

4. Click **Install** or **Save**.

That’s all on the GitHub side: the app will now send webhook events for those repos to the backend you run.

---

## 2. Clone the ContextWizard Probot backend

In your development machine:

```
git clone https://github.com/your-org/contextwizard-backend.git
cd contextwizard-backend
```