# SocialMonet

Monetize Facebook posts with 100+ likes. Connect your Facebook account, submit ad posts, and earn per like.

## Deployment

1. `npm install -g firebase-tools`
2. `firebase login`
3. `firebase use --add` (select your project: ritunda)
4. Replace `YOUR_FACEBOOK_APP_ID` and `YOUR_FACEBOOK_APP_SECRET` in `firebase/functions/index.js`
5. `firebase deploy --only functions,hosting,firestore`

## Environment Variables (optional)

firebase functions:config:set fb.app_id="xxx" fb.app_secret="yyy" app.encryption_key="zzz" app.redirect_uri="https://ritunda.web.app/dashboard.html"