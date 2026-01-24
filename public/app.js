(() => {
  // Purchase elements
  const planSel = document.getElementById('plan');
  const msisdnEl = document.getElementById('msisdn');
  const payBtn = document.getElementById('payBtn');
  const purchaseMsgEl = document.getElementById('purchaseMsg');

  // Voucher elements
  const voucherCodeEl = document.getElementById('voucherCode');
  const loginBtn = document.getElementById('loginBtn');
  const voucherMsgEl = document.getElementById('voucherMsg');

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab + 'Tab').classList.add('active');
    });
  });

  function showPurchaseMsg(text, ok=true){
    purchaseMsgEl.style.display = 'block';
    purchaseMsgEl.className = 'msg ' + (ok ? 'ok' : 'bad');
    purchaseMsgEl.textContent = text;
  }

  function showVoucherMsg(text, ok=true){
    voucherMsgEl.style.display = 'block';
    voucherMsgEl.className = 'msg ' + (ok ? 'ok' : 'bad');
    voucherMsgEl.textContent = text;
  }

  // Load plans for purchase
  async function loadPlans(){
    const r = await fetch('/api/portal/plans', { credentials: 'same-origin' });
    const j = await r.json();
    if(!j.ok) throw new Error(j.message || 'Failed to load plans');

    planSel.innerHTML = '';
    (j.plans || []).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.code;
      opt.textContent = `${p.name} — UGX ${p.price_ugx.toLocaleString()}`;
      planSel.appendChild(opt);
    });

    if (planSel.options.length === 0) {
      throw new Error('No active plans available');
    }
  }

  // Purchase flow
  payBtn.addEventListener('click', async () => {
    const msisdn = (msisdnEl.value || '').trim();
    const planCode = planSel.value;

    if(!msisdn || !/^256\d{9}$/.test(msisdn)){
      showPurchaseMsg('Enter a valid Uganda number like 2567XXXXXXXX', false);
      return;
    }

    payBtn.disabled = true;
    showPurchaseMsg('Initializing payment…', true);

    try {
      const r = await fetch('/api/payments/flutterwave/init', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ msisdn, planCode })
      });
      const j = await r.json();
      if(!j.ok) throw new Error(j.detail || j.message || 'Payment init failed');

      localStorage.setItem('last_order_ref', j.orderRef);
      window.location.href = j.paymentLink;

    } catch(e){
      showPurchaseMsg(e.message, false);
      payBtn.disabled = false;
    }
  });

  // Voucher login flow
  loginBtn.addEventListener('click', async () => {
    const code = (voucherCodeEl.value || '').trim().replace(/\D/g, '');

    if(!code || code.length < 5){
      showVoucherMsg('Please enter a valid 5-digit voucher code', false);
      return;
    }

    loginBtn.disabled = true;
    showVoucherMsg('Validating voucher…', true);

    try {
      const r = await fetch('/api/portal/voucher/validate', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ code })
      });
      const j = await r.json();

      if(!j.ok) {
        throw new Error(j.message || 'Invalid voucher code');
      }

      showVoucherMsg('Voucher valid! Connecting...', true);

      // Store voucher code
      localStorage.setItem('voucher_code', code);

      // Check for MikroTik redirect parameters
      const urlParams = new URLSearchParams(window.location.search);
      const linkLogin = urlParams.get('link-login') || urlParams.get('link-login-only');

      if(linkLogin) {
        // MikroTik hotspot - redirect with credentials
        const loginUrl = new URL(linkLogin);
        loginUrl.searchParams.set('username', code);
        loginUrl.searchParams.set('password', code);
        window.location.href = loginUrl.toString();
      } else {
        // Show success message with instructions
        showVoucherMsg(`Voucher valid! Use "${code}" as both username and password on the WiFi login page.`, true);
        loginBtn.disabled = false;
      }

    } catch(e){
      showVoucherMsg(e.message, false);
      loginBtn.disabled = false;
    }
  });

  // Allow only numeric input for voucher code
  voucherCodeEl.addEventListener('input', () => {
    voucherCodeEl.value = voucherCodeEl.value.replace(/\D/g, '');
  });

  // Submit on Enter key for voucher
  voucherCodeEl.addEventListener('keypress', (e) => {
    if(e.key === 'Enter') {
      loginBtn.click();
    }
  });

  // Save MikroTik hotspot redirect URL for later use (after payment)
  const urlParams = new URLSearchParams(window.location.search);
  const linkLogin = urlParams.get('link-login') || urlParams.get('link-login-only');
  if (linkLogin) {
    localStorage.setItem('hotspot_login_url', linkLogin);
  }

  // Initialize
  (async ()=>{
    try{
      await loadPlans();
    }catch(e){
      showPurchaseMsg('Error loading plans: ' + e.message, false);
    }
  })();
})();
