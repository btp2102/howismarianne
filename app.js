(function () {
  'use strict';

  const API_URL = window.FAMILY_UPDATES_BACKEND_URL || '';
  const TOKEN_KEY = 'familyUpdatesToken';
  const NAME_KEY = 'familyUpdatesName';
  const TITLE_KEY = 'familyUpdatesTitle';

  const $ = id => document.getElementById(id);

  // localStorage can throw (private mode, blocked storage); never let that break the page.
  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    remove(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  let token = store.get(TOKEN_KEY);
  let role = null;
  let nextBefore = null;
  const postEls = new Map(); // post id -> its <article>

  const loginScreen = $('loginScreen');
  const site = $('site');
  const postsEl = $('posts');
  const moreButton = $('moreButton');
  const welcomeEl = $('welcome');

  // The title comes from the Settings tab. Remember it so repeat visits show it instantly.
  function applyTitle(title) {
    if (!title) return;
    $('siteTitle').textContent = title;
    $('loginTitle').textContent = title;
    $('noticeTitle').textContent = title;
    document.title = title;
    store.set(TITLE_KEY, title);
  }

  function renderWelcome(text) {
    if (text && text.trim()) {
      welcomeEl.innerHTML = richTextToHtml(text);
      welcomeEl.hidden = false;
    } else {
      welcomeEl.textContent = '';
      welcomeEl.hidden = true;
    }
  }

  applyTitle(store.get(TITLE_KEY));

  // ------------------------------------------------------------ backend

  async function api(action, ...args) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    let res;
    try {
      // No custom headers and a string body => a "simple" request, so no CORS preflight
      // (Apps Script cannot answer preflights).
      res = await fetch(API_URL, {
        method: 'POST',
        body: JSON.stringify({ action, args }),
        credentials: 'omit',
        redirect: 'follow',
        signal: ctrl.signal
      });
    } catch (e) {
      throw new Error(e && e.name === 'AbortError'
        ? 'The request timed out. Please try again.'
        : 'Could not reach the server. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('The server sent an unexpected response.'); }
    if (!data || !data.ok) {
      const err = new Error((data && data.error) || 'Request failed.');
      err.code = (data && data.code) || '';
      throw err;
    }
    return data.result;
  }

  // ------------------------------------------------------------ screens

  function showLogin(message) {
    site.hidden = true;
    loginScreen.hidden = false;
    $('loginError').textContent = message || '';
    $('password').focus();
  }

  function showSite() {
    loginScreen.hidden = true;
    site.hidden = false;
  }

  function clearSession() {
    token = '';
    role = null;
    nextBefore = null;
    store.remove(TOKEN_KEY);
    postsEl.textContent = '';
    postEls.clear();
    moreButton.hidden = true;
    renderWelcome('');
    hidePostForm();
    applyAlerts(false);
  }

  function signOutWithMessage(message) {
    clearSession();
    showLogin(message);
  }

  function applyRole() {
    $('newPostButton').hidden = role !== 'family';
  }

  function handleError(err, statusEl) {
    if (err && err.code === 'AUTH') {
      signOutWithMessage(err.message || 'Please sign in again.');
      return;
    }
    if (statusEl) statusEl.textContent = (err && err.message) || 'Something went wrong.';
  }

  // ------------------------------------------------------------ login / start

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('password');
    const button = $('loginButton');
    const errorEl = $('loginError');
    errorEl.textContent = '';
    if (!input.value) { errorEl.textContent = 'Please enter the password.'; return; }
    button.disabled = true;
    try {
      const data = await api('login', input.value);
      token = data.token;
      store.set(TOKEN_KEY, token);
      input.value = '';
      showSite();
      renderFirstPage(data);
    } catch (err) {
      errorEl.textContent = (err && err.message) || 'Unable to sign in.';
    } finally {
      button.disabled = false;
    }
  });

  $('logoutButton').addEventListener('click', () => {
    clearSession();
    showLogin('');
  });

  async function loadFirstPage() {
    postsEl.innerHTML = '<div class="empty">Loading updates…</div>';
    try {
      const data = await api('posts', token, null);
      renderFirstPage(data);
    } catch (err) {
      if (err && err.code === 'AUTH') { signOutWithMessage(''); return; }
      postsEl.textContent = '';
      const msg = document.createElement('div');
      msg.className = 'error';
      msg.textContent = (err && err.message) || 'Unable to load updates.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'text-button';
      retry.textContent = 'Try again';
      retry.addEventListener('click', loadFirstPage);
      postsEl.append(msg, retry);
    }
  }

  function start() {
    // Links in alert emails open this page with ?confirm=... or ?unsubscribe=...
    const params = new URLSearchParams(location.search);
    const emailToken = params.get('confirm') || params.get('unsubscribe');
    if (emailToken && API_URL && API_URL.indexOf('PASTE_') !== 0) {
      handleEmailLink(params.get('confirm') ? 'confirm' : 'unsubscribe', emailToken);
      return;
    }
    if (!API_URL || API_URL.indexOf('PASTE_') === 0) {
      showLogin('This site is not connected to its backend yet. Add the backend URL to config.js.');
      $('loginButton').disabled = true;
      return;
    }
    if (token) {
      showSite();
      loadFirstPage();
    } else {
      showLogin('');
      // The sign-in screen needs the title before anyone is signed in.
      api('info').then(r => applyTitle(r && r.title)).catch(() => {});
    }
  }

  // ------------------------------------------------------------ email alerts

  function applyAlerts(on) {
    $('alertsTools').hidden = !on;
    if (!on) hideAlertsForm();
  }

  $('alertsButton').addEventListener('click', () => {
    const form = $('alertsForm');
    if (!form.hidden) { hideAlertsForm(); return; }
    $('alertsResponsesRow').hidden = role !== 'family';   // only family can follow responses
    form.hidden = false;
    $('alertsEmail').focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('alertsCancel').addEventListener('click', hideAlertsForm);

  function hideAlertsForm() {
    $('alertsForm').hidden = true;
    $('alertsStatus').textContent = '';
  }

  $('alertsSend').addEventListener('click', async () => {
    const email = $('alertsEmail').value.trim();
    const updates = $('alertsUpdates').checked;
    const responses = role === 'family' && $('alertsResponses').checked;
    const status = $('alertsStatus');
    const button = $('alertsSend');
    if (!email) { status.textContent = 'Please enter your email address.'; return; }
    if (!updates && !responses) { status.textContent = 'Please choose at least one kind of email.'; return; }
    button.disabled = true;
    status.textContent = 'Sending…';
    try {
      await api('subscribe', token, email, updates, responses);
      status.textContent = 'Almost done: we sent a confirmation email to ' + email +
        '. Open it and tap the link. It can take a few minutes, and it may land in your spam folder.';
    } catch (err) {
      handleError(err, status);
    } finally {
      button.disabled = false;
    }
  });

  async function handleEmailLink(kind, tok) {
    loginScreen.hidden = true;
    site.hidden = true;
    $('noticeScreen').hidden = false;
    const text = $('noticeText');
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }   // keep the token out of the address bar
    api('info').then(r => applyTitle(r && r.title)).catch(() => {});
    try {
      if (kind === 'confirm') {
        text.textContent = confirmMessage(await api('confirmEmail', tok));
      } else {
        const r = await api('unsubscribe', tok);
        text.textContent = r.removed
          ? "You've been unsubscribed, and your address has been removed. You won't get any more emails."
          : "You're not on the email list. This link may already have been used.";
      }
    } catch (err) {
      text.textContent = (err && err.message) || 'Something went wrong. Please try again.';
    }
    $('noticeLink').hidden = false;
  }

  function confirmMessage(r) {
    if (!r.confirmed) return 'There was nothing to confirm.';
    if (r.updates && r.responses) return "You're all set. You'll get an email when there are new updates or new responses.";
    if (r.responses) return "You're all set. You'll get an email when there are new responses.";
    return "You're all set. You'll get an email when there is a new update.";
  }

  // ------------------------------------------------------------ posts

  function renderFirstPage(data) {
    role = data.role;
    nextBefore = data.next;
    if (data.token) { token = data.token; store.set(TOKEN_KEY, token); }   // renewed for another 40 days
    applyTitle(data.title);
    renderWelcome(data.welcome);
    applyAlerts(!!data.alerts);
    postsEl.textContent = '';
    postEls.clear();
    applyRole();
    if (!data.posts.length) {
      showEmpty();
    } else {
      data.posts.forEach(p => mountPost(p, 'append'));
    }
    moreButton.hidden = !nextBefore;
  }

  function showEmpty() {
    postsEl.innerHTML = '<div class="empty">No updates yet.</div>';
  }

  function mountPost(post, where) {
    const empty = postsEl.querySelector('.empty');
    if (empty) empty.remove();
    const el = buildPost(post);
    postEls.set(post.id, el);
    if (where === 'prepend') postsEl.prepend(el); else postsEl.append(el);
  }

  function refreshPost(post) {
    const old = postEls.get(post.id);
    const el = buildPost(post);
    if (old) old.replaceWith(el);
    postEls.set(post.id, el);
  }

  function buildPost(post) {
    const article = document.createElement('article');
    article.className = 'post';

    const date = document.createElement('div');
    date.className = 'post-date';
    date.textContent = formatDate(post.createdAt);

    const author = document.createElement('div');
    author.className = 'post-author';
    author.textContent = post.author;

    article.append(date, author);

    if (post.title) {
      const title = document.createElement('h2');
      title.className = 'post-title';
      title.textContent = post.title;
      article.appendChild(title);
    }

    const body = document.createElement('div');
    body.className = 'post-body';
    body.innerHTML = richTextToHtml(post.body);
    article.appendChild(body);

    article.appendChild(buildResponses(post));
    return article;
  }

  moreButton.addEventListener('click', async () => {
    if (!nextBefore) return;
    moreButton.disabled = true;
    try {
      const data = await api('posts', token, nextBefore);
      nextBefore = data.next;
      data.posts.forEach(p => { if (!postEls.has(p.id)) mountPost(p, 'append'); });
      moreButton.hidden = !nextBefore;
    } catch (err) {
      handleError(err, null);
      if (!(err && err.code === 'AUTH')) alert((err && err.message) || 'Unable to load older updates.');
    } finally {
      moreButton.disabled = false;
    }
  });

  // ------------------------------------------------------------ publish

  $('newPostButton').addEventListener('click', () => {
    if (role !== 'family') return;
    $('postForm').hidden = false;
    const author = $('postAuthor');
    if (!author.value) author.value = store.get(NAME_KEY);
    author.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('cancelPostButton').addEventListener('click', hidePostForm);

  function hidePostForm() {
    $('postForm').hidden = true;
    $('postStatus').textContent = '';
  }

  $('publishButton').addEventListener('click', async () => {
    if (role !== 'family') return;
    const author = $('postAuthor').value.trim();
    const title = $('postTitle').value.trim();
    const editor = $('postEditor');
    const body = editorToMarkup(editor);
    const button = $('publishButton');
    const status = $('postStatus');

    if (!author) { status.textContent = 'Please enter the author name.'; return; }
    if (!stripMarkup(body).trim()) { status.textContent = 'Please write an update.'; return; }

    button.disabled = true;
    status.textContent = 'Publishing…';
    try {
      const post = await api('createPost', token, author, title, body);
      store.set(NAME_KEY, author);
      $('postTitle').value = '';
      editor.innerHTML = '';
      hidePostForm();
      mountPost(post, 'prepend');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      handleError(err, status);
    } finally {
      button.disabled = false;
    }
  });

  // ------------------------------------------------------------ responses

  function buildResponses(post) {
    const wrapper = document.createElement('div');
    wrapper.className = 'responses';

    if (post.comments.length) {
      const heading = document.createElement('div');
      heading.className = 'responses-heading';
      heading.textContent = post.comments.length === 1 ? '1 response' : post.comments.length + ' responses';
      wrapper.appendChild(heading);

      post.comments.forEach(comment => {
        const item = document.createElement('div');
        item.className = 'comment';

        const meta = document.createElement('div');
        meta.className = 'comment-meta';
        const name = document.createElement('span');
        name.className = 'comment-name';
        name.textContent = comment.name;
        meta.append(name, document.createTextNode(' · ' + formatDate(comment.createdAt)));

        const body = document.createElement('div');
        body.className = 'comment-body';
        body.innerHTML = richTextToHtml(comment.body);

        item.append(meta, body);
        wrapper.appendChild(item);
      });
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-button respond-button';
    button.textContent = 'Post a response';
    button.addEventListener('click', () => toggleCommentForm(post, wrapper));
    wrapper.appendChild(button);
    return wrapper;
  }

  function toggleCommentForm(post, wrapper) {
    const existing = wrapper.querySelector('.comment-form');
    if (existing) { existing.remove(); return; }

    const form = $('commentFormTemplate').content.firstElementChild.cloneNode(true);
    const nameInput = form.querySelector('.comment-name-input');
    nameInput.value = store.get(NAME_KEY);
    form.querySelector('.cancel-comment').addEventListener('click', () => form.remove());
    form.querySelector('.submit-comment').addEventListener('click', () => submitComment(post, form));
    wrapper.appendChild(form);
    (nameInput.value ? form.querySelector('.comment-editor') : nameInput).focus();
  }

  async function submitComment(post, form) {
    const name = form.querySelector('.comment-name-input').value.trim();
    const body = editorToMarkup(form.querySelector('.comment-editor'));
    const status = form.querySelector('.comment-status');
    const button = form.querySelector('.submit-comment');

    if (!name) { status.textContent = 'Please enter your name.'; return; }
    if (!stripMarkup(body).trim()) { status.textContent = 'Please write a response.'; return; }

    button.disabled = true;
    status.textContent = 'Posting…';
    try {
      const comment = await api('createComment', token, post.id, name, body);
      store.set(NAME_KEY, name);
      post.comments.push(comment);
      refreshPost(post);
    } catch (err) {
      button.disabled = false;
      handleError(err, status);
    }
  }

  // ------------------------------------------------------------ editor (B / I / U)

  // Keep the text selection when a toolbar button is pressed.
  document.addEventListener('mousedown', e => {
    if (e.target.closest && e.target.closest('.toolbar button')) e.preventDefault();
  });

  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('.toolbar button[data-cmd]');
    if (!btn) return;
    const editor = btn.closest('.editor-shell').querySelector('.editor');
    editor.focus();
    document.execCommand(btn.dataset.cmd, false, null);
  });

  // Paste as plain text so formatting from Word/web pages doesn't sneak in.
  document.addEventListener('paste', e => {
    const editor = e.target.closest && e.target.closest('.editor');
    if (!editor) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  // Editor HTML -> the stored [b]/[i]/[u] markup.
  function editorToMarkup(editor) {
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName.toLowerCase();
      let content = '';
      node.childNodes.forEach(c => { content += walk(c); });
      if (tag === 'strong' || tag === 'b') return '[b]' + content + '[/b]';
      if (tag === 'em' || tag === 'i') return '[i]' + content + '[/i]';
      if (tag === 'u') return '[u]' + content + '[/u]';
      if (tag === 'br') return '\n';
      if (tag === 'div' || tag === 'p') return content + '\n';
      return content;
    }
    let result = '';
    editor.childNodes.forEach(n => { result += walk(n); });
    // contenteditable inserts non-breaking spaces; store plain spaces so text wraps normally
    return result.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Stored markup -> safe HTML. Everything is escaped first; only b/i/u are re-enabled.
  function richTextToHtml(text) {
    const safe = escapeHtml(text || '')
      .replace(/\[b\]/gi, '<strong>').replace(/\[\/b\]/gi, '</strong>')
      .replace(/\[i\]/gi, '<em>').replace(/\[\/i\]/gi, '</em>')
      .replace(/\[u\]/gi, '<u>').replace(/\[\/u\]/gi, '</u>');
    return safe.split(/\n{2,}/).map(p => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
  }

  function stripMarkup(text) {
    return String(text || '').replace(/\[\/?(b|i|u)\]/gi, '');
  }

  function escapeHtml(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function formatDate(value) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    }).format(d);
  }

  start();
})();
