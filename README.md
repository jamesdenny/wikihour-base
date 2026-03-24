# WikiHour Base

This is a Cloudflare Worker that runs WikiHour, a mini dashboard for recent wikipedia edits and a word-cloud style visualization of the most common words in the edits. Created with Google AI Mode.

Includes OpenAI for the AI-powered PG-rating filter (and leo-profanity for base filtering).

### Local Project Initialisation
Either clone this repo, or run the following bash commands in your terminal:
```
# 1. Create and enter the directory
mkdir wikihour-base && cd wikihour-base

# 2. Initialise the project
npm init -y

# 3. Install the required packages
npm install stopword leo-profanity wrangler --save-dev

# 4. Create the folder structure
mkdir src public
```

## Installation

1. Install [Wrangler](https://github.com/cloudflare/wrangler)
2. Authenticate Wrangler with your Cloudflare account
3. `npm install` to install dependencies

## Usage

1. `wrangler publish` to deploy the worker to Cloudflare
2. Create a new route for the worker in the Cloudflare dashboard
3. Configure the environment variables for your worker

## Additional setup

### Provider Accounts
 - GitHub: Create a repository to hold your files.
 - Cloudflare: Sign up for a free account. You’ll use Workers, Durable Objects (Free tier allows 1M requests/month), and AI Gateway.
 - OpenAI: Sign up at platform.openai.com and add a small amount of credit ($5 is plenty for months of filtering).

### Provider Setup (API Keys)
 - OpenAI: Generate a Secret Key (sk-...).
 - Cloudflare AI Gateway:
   - In the Cloudflare dashboard, go to AI > AI Gateway.
   - Create a gateway named wiki-moderator.
   - Copy your Account ID from the sidebar and the Gateway ID you just created.

### The "Keep-Alive"
Because Cloudflare Workers can "sleep" to save resources:
- Go to Cron-job.org (Free).
- Set a job to ping https://your-app.workers.dev every 1 minute.
- This ensures the Wikipedia stream never disconnects and your 1-hour history is always full.

## Local Test/Run
Before going live, check that it works on your machine:
`npx wrangler dev`

Open http://localhost:8787. Wait 10 seconds for the first data chunk.

## Deployment
Push it to the world:
1. Add Production Secret:
```
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put CF_ACCOUNT_ID
Use code with caution.
```

2. Deploy:
```
npx wrangler deploy
```

## Automated Updates (GitHub Actions)
- Push your code to GitHub.
- In GitHub, go to Settings > Secrets and add CLOUDFLARE_API_TOKEN.
- Add the `.github/workflows/deploy.yml` file we created.
- Now, every git push updates your live site.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
