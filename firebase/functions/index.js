const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');
const CryptoJS = require('crypto-js');

admin.initializeApp();
const db = admin.firestore();

// Configuration (set these in Firebase Environment Config or hardcode for testing)
const FB_APP_ID = functions.config().fb.app_id || "YOUR_FACEBOOK_APP_ID";
const FB_APP_SECRET = functions.config().fb.app_secret || "YOUR_FACEBOOK_APP_SECRET";
const ENCRYPTION_KEY = functions.config().app.encryption_key || "my-secret-key-32-chars-long!!!";
const REDIRECT_URI = functions.config().app.redirect_uri || "https://ritunda.web.app/dashboard.html";  // Update to your actual URL

function encrypt(text) {
  return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
}

function decrypt(ciphertext) {
  const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// ========== FUNCTION 1: Connect Facebook ==========
exports.connectFacebook = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  const { fbAuthCode } = data;
  const userId = context.auth.uid;
  try {
    const tokenResponse = await axios.get(`https://graph.facebook.com/v18.0/oauth/access_token`, {
      params: { client_id: FB_APP_ID, redirect_uri: REDIRECT_URI, client_secret: FB_APP_SECRET, code: fbAuthCode }
    });
    const accessToken = tokenResponse.data.access_token;
    const fbUserId = tokenResponse.data.user_id;
    const postsResponse = await axios.get(`https://graph.facebook.com/v18.0/${fbUserId}/posts`, {
      params: { fields: 'id,likes.summary(true),created_time', access_token: accessToken, limit: 50 }
    });
    let hasQualifiedPost = false;
    let bestPost = null;
    for (const post of postsResponse.data.data) {
      const likeCount = post.likes?.summary?.total_count || 0;
      if (likeCount >= 100) {
        hasQualifiedPost = true;
        bestPost = { id: post.id, likeCount: likeCount, created_time: post.created_time };
        break;
      }
    }
    await db.collection('users').doc(userId).set({
      fbConnected: true, fbAccessToken: encrypt(accessToken), fbUserId: fbUserId,
      qualifiedForMonetization: hasQualifiedPost, bestPostId: bestPost?.id || null,
      bestPostLikes: bestPost?.likeCount || 0, connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastCheckedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    if (hasQualifiedPost && bestPost) {
      await db.collection('posts').doc(bestPost.id).set({
        postId: bestPost.id, userId: userId, fbPostId: bestPost.id,
        likeCountAtConnect: bestPost.likeCount, currentLikeCount: bestPost.likeCount,
        isQualified: true, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    return { success: true, qualified: hasQualifiedPost, likeCount: bestPost?.likeCount || 0 };
  } catch (error) {
    console.error(error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ========== FUNCTION 2: Get Dashboard Stats ==========
exports.getStats = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  const userId = context.auth.uid;
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) return { connected: false };
  const userData = userDoc.data();
  const earningsSnapshot = await db.collection('earnings').where('userId', '==', userId).orderBy('paidAt', 'desc').limit(100).get();
  let totalEarned = 0;
  const earnings = [];
  earningsSnapshot.forEach(doc => { const d = doc.data(); totalEarned += d.amountPaid; earnings.push(d); });
  const campaignsSnapshot = await db.collection('campaigns').where('active', '==', true).get();
  const campaigns = [];
  campaignsSnapshot.forEach(doc => campaigns.push({ id: doc.id, ...doc.data() }));
  return {
    connected: userData.fbConnected || false, qualified: userData.qualifiedForMonetization || false,
    bestPostLikes: userData.bestPostLikes || 0, totalEarned: totalEarned,
    pendingBalance: userData.pendingBalance || 0, campaigns: campaigns, recentEarnings: earnings.slice(0, 10)
  };
});

// ========== FUNCTION 3: Submit Ad Post ==========
exports.submitAdPost = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  const { campaignId, postUrl } = data;
  const userId = context.auth.uid;
  const userDoc = await db.collection('users').doc(userId).get();
  const userData = userDoc.data();
  if (!userData.fbConnected) throw new functions.https.HttpsError('failed-precondition', 'Connect Facebook first');
  if (!userData.qualifiedForMonetization) throw new functions.https.HttpsError('failed-precondition', 'Need a post with 100+ likes');
  const campaignDoc = await db.collection('campaigns').doc(campaignId).get();
  const campaign = campaignDoc.data();
  if (!campaign || !campaign.active || campaign.remainingBudget <= 0) throw new functions.https.HttpsError('not-found', 'Campaign not available');
  function extractPostIdFromUrl(url) {
    const patterns = [/facebook\.com\/\d+\/posts\/(\d+)/, /facebook\.com\/photo\.php\?fbid=(\d+)/, /facebook\.com\/posts\/(\d+)/];
    for (const pattern of patterns) { const match = url.match(pattern); if (match) return match[1]; }
    return null;
  }
  const fbPostId = extractPostIdFromUrl(postUrl);
  if (!fbPostId) throw new functions.https.HttpsError('invalid-argument', 'Invalid Facebook post URL');
  async function getCurrentLikeCount(postId, accessToken) {
    try {
      const response = await axios.get(`https://graph.facebook.com/v18.0/${postId}`, { params: { fields: 'likes.summary(true)', access_token: accessToken } });
      return response.data.likes?.summary?.total_count || 0;
    } catch (e) { return 0; }
  }
  const initialLikeCount = await getCurrentLikeCount(fbPostId, decrypt(userData.fbAccessToken));
  await db.collection('submissions').add({
    userId, campaignId, fbPostId, postUrl, status: 'pending',
    submittedAt: admin.firestore.FieldValue.serverTimestamp(), initialLikeCount
  });
  return { success: true, message: 'Ad submission recorded. Earnings will be calculated within 24 hours.' };
});

// ========== FUNCTION 4: Daily Earnings Scanner ==========
exports.dailyEarningsScanner = functions.pubsub.schedule('0 6 * * *').timeZone('UTC').onRun(async () => {
  console.log('Starting daily earnings scan...');
  const usersSnapshot = await db.collection('users').where('fbConnected', '==', true).where('qualifiedForMonetization', '==', true).get();
  for (const userDoc of usersSnapshot.docs) {
    const user = userDoc.data();
    const decryptedToken = decrypt(user.fbAccessToken);
    const submissionsSnapshot = await db.collection('submissions').where('userId', '==', userDoc.id).where('status', '==', 'pending').get();
    for (const subDoc of submissionsSnapshot.docs) {
      const submission = subDoc.data();
      async function getCurrentLikeCount(postId, token) {
        try {
          const res = await axios.get(`https://graph.facebook.com/v18.0/${postId}`, { params: { fields: 'likes.summary(true)', access_token: token } });
          return res.data.likes?.summary?.total_count || 0;
        } catch (e) { return 0; }
      }
      const currentLikes = await getCurrentLikeCount(submission.fbPostId, decryptedToken);
      const initialLikes = submission.initialLikeCount || 0;
      const newLikes = Math.max(0, currentLikes - initialLikes);
      if (newLikes > 0) {
        const campaignDoc = await db.collection('campaigns').doc(submission.campaignId).get();
        const campaign = campaignDoc.data();
        const earnings = newLikes * campaign.payoutPerLike;
        await db.collection('earnings').add({ userId: userDoc.id, campaignId: submission.campaignId, postId: submission.fbPostId, likesGenerated: newLikes, amountPaid: earnings, paidAt: admin.firestore.FieldValue.serverTimestamp() });
        await db.collection('users').doc(userDoc.id).update({ pendingBalance: admin.firestore.FieldValue.increment(earnings), totalEarned: admin.firestore.FieldValue.increment(earnings) });
        await db.collection('campaigns').doc(submission.campaignId).update({ remainingBudget: admin.firestore.FieldValue.increment(-earnings) });
        await db.collection('submissions').doc(subDoc.id).update({ status: 'processed', finalLikeCount: currentLikes, newLikes, earnings, processedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
  }
  return null;
});

// ========== FUNCTION 5: Request Withdrawal ==========
exports.requestWithdrawal = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  const userId = context.auth.uid;
  const userDoc = await db.collection('users').doc(userId).get();
  const userData = userDoc.data();
  const pendingBalance = userData.pendingBalance || 0;
  if (pendingBalance < 20) throw new functions.https.HttpsError('failed-precondition', 'Minimum withdrawal is $20');
  await db.collection('withdrawals').add({ userId, amount: pendingBalance, status: 'pending', requestedAt: admin.firestore.FieldValue.serverTimestamp() });
  await db.collection('users').doc(userId).update({ pendingBalance: 0, lastWithdrawalRequest: admin.firestore.FieldValue.serverTimestamp() });
  return { success: true, amount: pendingBalance, message: 'Withdrawal request submitted. We will process within 5-7 business days.' };
});

// ========== FUNCTION 6: Refresh Facebook Data ==========
exports.refreshFacebookData = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be logged in');
  const userId = context.auth.uid;
  const userDoc = await db.collection('users').doc(userId).get();
  const userData = userDoc.data();
  if (!userData.fbConnected) throw new functions.https.HttpsError('failed-precondition', 'Facebook not connected');
  const decryptedToken = decrypt(userData.fbAccessToken);
  const fbUserId = userData.fbUserId;
  const postsResponse = await axios.get(`https://graph.facebook.com/v18.0/${fbUserId}/posts`, { params: { fields: 'id,likes.summary(true),created_time', access_token: decryptedToken, limit: 20 } });
  let hasQualifiedPost = userData.qualifiedForMonetization;
  let bestPostLikes = userData.bestPostLikes;
  for (const post of postsResponse.data.data) {
    const likeCount = post.likes?.summary?.total_count || 0;
    if (likeCount > bestPostLikes) { bestPostLikes = likeCount; if (likeCount >= 100) hasQualifiedPost = true; }
  }
  await db.collection('users').doc(userId).update({ qualifiedForMonetization: hasQualifiedPost, bestPostLikes: bestPostLikes, lastCheckedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { qualified: hasQualifiedPost, bestPostLikes: bestPostLikes };
});