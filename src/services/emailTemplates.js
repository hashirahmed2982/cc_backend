function fill(str, vars) {
  return str.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

const templates = {
  orderConfirmation: (vars) => ({
    subject: fill('Order Confirmation – {Order_ID}', vars),
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>Thank you for placing an order with CardCove FZC.</p>
      <p>Your order has been successfully received and is currently being processed.</p>
      <h3>Order Details</h3>
      <ul>
        <li>Order ID: {Order_ID}</li>
        <li>Order Date: {Date}</li>
        <li>Order Value: {Amount} {Currency}</li>
      </ul>
      <p>You will receive a separate notification once the order has been fulfilled and the digital products are delivered.</p>
      <p>If you have any questions regarding your order, please contact our support team.</p>
      <p>Best regards,<br>CardCove FZC<br>Digital Gift Cards & E-Vouchers</p>
    </div>`, vars)
  }),

  orderFulfilled: (vars) => ({
    subject: fill('Order Fulfilled – {Order_ID}', vars),
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>We are pleased to inform you that your order has been successfully fulfilled.</p>
      <h3>Order Details</h3>
      <ul>
        <li>Order ID: {Order_ID}</li>
        <li>Fulfillment Date: {Date}</li>
        <li>Order Value: {Amount} {Currency}</li>
      </ul>
      <p>The requested digital gift cards / e-vouchers have been delivered to your account or via the agreed delivery method.</p>
      <p>You may access the order details and download the codes directly from your CardCove dashboard.</p>
      <p>If you require any assistance, please contact our support team.</p>
      <p>Best regards,<br>CardCove FZC<br>Digital Gift Cards & E-Vouchers</p>
    </div>`, vars)
  }),

  orderFailed: (vars) => ({
    subject: fill('Order Update – {Order_ID}', vars),
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>We regret to inform you that your recent order could not be fulfilled at this time.</p>
      <h3>Order Details</h3>
      <ul>
        <li>Order ID: {Order_ID}</li>
        <li>Order Date: {Date}</li>
        <li>Order Value: {Amount} {Currency}</li>
      </ul>
      <p>Possible reasons may include temporary stock unavailability or a system processing issue.</p>
      <p>If the order amount was deducted from your wallet, the balance will be automatically adjusted or refunded according to our system process.</p>
      <p>Please feel free to contact our support team if you require further clarification.</p>
      <p>Best regards,<br>CardCove FZC<br>Operations Team</p>
    </div>`, vars)
  }),

  orderPartial: (vars) => ({
    subject: fill('Order Partially Fulfilled – {Order_ID}', vars),
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>We would like to inform you that your recent order has been partially fulfilled.</p>
      <p>Due to temporary stock limitations, only part of the requested quantity was successfully delivered.</p>
      <h3>Order Details</h3>
      <ul>
        <li>Order ID: {Order_ID}</li>
        <li>Order Date: {Date}</li>
        <li>Total Order Value: {Total_Amount} {Currency}</li>
        <li>Fulfilled Amount: {Fulfilled_Amount} {Currency}</li>
        <li>Pending / Unfulfilled Amount: {Remaining_Amount} {Currency}</li>
      </ul>
      <p>Any undelivered portion of the order will either be:</p>
      <ul>
        <li>Refunded back to your wallet balance automatically, or</li>
        <li>Fulfilled once stock becomes available, depending on system configuration.</li>
      </ul>
      <p>You may review the delivered items and updated order status directly from your CardCove dashboard.</p>
      <p>If you require further assistance, please contact our support team.</p>
      <p>Best regards,<br>CardCove FZC<br>Operations Team<br>Digital Gift Cards & E-Vouchers</p>
    </div>`, vars)
  }),

  topUpReceived: (vars) => ({
    subject: 'Wallet Top-Up Request Received',
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>We have received your wallet top-up request.</p>
      <h3>Top-Up Details</h3>
      <ul>
        <li>Reference ID: {Reference_ID}</li>
        <li>Requested Amount: {Amount} {Currency}</li>
        <li>Request Date: {Date}</li>
      </ul>
      <p>Our finance team will review and process the request shortly.</p>
      <p>You will be notified once the wallet balance has been updated.</p>
      <p>Best regards,<br>CardCove FZC<br>Finance & Accounts Team</p>
    </div>`, vars)
  }),

  topUpSuccessful: (vars) => ({
    subject: 'Wallet Top-Up Successful',
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>Your wallet top-up has been successfully processed.</p>
      <h3>Transaction Details</h3>
      <ul>
        <li>Reference ID: {Reference_ID}</li>
        <li>Top-Up Amount: {Amount} {Currency}</li>
        <li>Updated Wallet Balance: {Wallet_Balance} {Currency}</li>
        <li>Date Processed: {Date}</li>
      </ul>
      <p>Your balance is now available for purchases on the CardCove platform.</p>
      <p>Best regards,<br>CardCove FZC<br>Finance Department</p>
    </div>`, vars)
  }),

  topUpCanceled: (vars) => ({
    subject: 'Wallet Top-Up Request Update',
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>We regret to inform you that your wallet top-up request could not be completed.</p>
      <h3>Request Details</h3>
      <ul>
        <li>Reference ID: {Reference_ID}</li>
        <li>Requested Amount: {Amount} {Currency}</li>
        <li>Request Date: {Date}</li>
      </ul>
      <p>If you believe this request was canceled in error or require assistance, please contact our finance team.</p>
      <p>Best regards,<br>CardCove FZC<br>Finance Department</p>
    </div>`, vars)
  }),

  walletBalanceSettled: (vars) => ({
    subject: 'Wallet Balance Settlement Confirmation',
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>This is to confirm that your account wallet balance has been settled.</p>
      <h3>Settlement Details</h3>
      <ul>
        <li>Amount Settled: {Amount} {Currency}</li>
        <li>Settlement Date: {Date}</li>
        <li>Current Wallet Balance: {Wallet_Balance} {Currency}</li>
      </ul>
      <p>Thank you for your continued partnership with CardCove FZC.</p>
      <p>Best regards,<br>CardCove FZC<br>Accounts Department</p>
    </div>`, vars)
  }),

  accountBlocked: (vars) => ({
    subject: 'Account Access Restricted',
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>Your CardCove account has been temporarily restricted.</p>
      <h3>Account Status</h3>
      <ul>
        <li>Reason: Security / Compliance Review</li>
        <li>Date: {Date}</li>
      </ul>
      <p>During this time, access to purchasing and wallet services may be limited.</p>
      <p>Our compliance team will review the account and notify you once the process is complete.</p>
      <p>If you require assistance, please contact our support team.</p>
      <p>Best regards,<br>CardCove FZC<br>Risk & Compliance Team</p>
    </div>`, vars)
  }),

  accountPaused: (vars) => ({
    subject: 'Account Temporarily Paused',
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>Your CardCove account has been temporarily paused.</p>
      <h3>Account Status</h3>
      <ul>
        <li>Status: Temporarily Paused</li>
        <li>Date: {Date}</li>
      </ul>
      <p>During this period, new orders and wallet transactions will not be processed.</p>
      <p>You will be notified once the account is reactivated.</p>
      <p>Best regards,<br>CardCove FZC<br>Account Management Team</p>
    </div>`, vars)
  }),

  accountReactivated: (vars) => ({
    subject: 'Account Reactivated',
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>We are pleased to inform you that your CardCove account has been successfully reactivated.</p>
      <p>You may now resume placing orders and using wallet services on the platform.</p>
      <h3>Account Details</h3>
      <ul>
        <li>Reactivation Date: {Date}</li>
      </ul>
      <p>Thank you for your cooperation.</p>
      <p>Best regards,<br>CardCove FZC<br>Account Management Team</p>
    </div>`, vars)
  }),

  passwordReset: (vars) => ({
    subject: 'Password Reset Request',
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Client_Name},</p>
      <p>We received a request to reset your CardCove account password.</p>
      <p>To proceed with the password reset, please use the secure link below:</p>
      <p><a href="{Password_Reset_Link}" style="color: #0066cc; text-decoration: none;">Reset Password</a></p>
      <p>If you did not request this action, please contact our support team immediately.</p>
      <p>Best regards,<br>CardCove FZC<br>Security Team</p>
    </div>`, vars)
  }),

  vendorOnboarding: (vars) => ({
    subject: fill('Vendor Onboarding Approved – Welcome to CardCove', vars),
    html: fill(`<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
      <p>Dear {Vendor_Name},</p>
      <p>Welcome to CardCove FZC.</p>
      <p>We are pleased to confirm that your vendor account has been successfully onboarded to our digital gift card distribution platform.</p>
      <p>You can now access the vendor portal and begin managing products and transactions.</p>
      <h3>Vendor Portal Access</h3>
      <p><a href="{Platform_URL}" style="color: #0066cc; text-decoration: none;">{Platform_URL}</a></p>
      <p>Our team looks forward to building a successful partnership.</p>
      <p>Best regards,<br>CardCove FZC<br>Vendor Management Team</p>
    </div>`, vars)
  })
};

module.exports = templates;

