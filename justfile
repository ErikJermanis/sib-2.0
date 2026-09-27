push:
    git add .
    git commit -m "push"
    git push

# Use this instead of a bare npm ci: npm ci does not enforce min-release-age.
install:
    node scripts/check-dependency-age.mjs
    npm ci --include=dev

# Runs the separately installed copy of scripts/deploy.sh on the VPS.
deploy:
    ssh -o BatchMode=yes erik@erikjermanis.me 'bash /home/erik/sites/sib-2.0/deploy.sh'
