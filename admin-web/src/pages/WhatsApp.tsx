import { MessageCircle } from 'lucide-react';
import { useHead } from '../Shell';
import { Client, NotConnected } from '../ui';

// D8b WhatsApp message templates (21:14000). The list and {{1}}… order mirror
// backend/src/lib/whatsapp.ts (PARAMS) — the templates the API actually sends.
const TEMPLATES: [string, string, string[]][] = [
  ['welcome', 'After sign-up', ['name', 'mobile']],
  ['daily_summary', '9 pm, once a day (not per scan)', ['count', 'points', 'pointsBalance', 'runsBalance', 'left']],
  ['scratch_card', 'Scratch card won', ['name']],
  ['withdrawal_approved', 'Withdrawal approved', ['amount']],
  ['withdrawal_paid', 'Paid, with UTR', ['amount', 'upi', 'utr', 'date']],
  ['withdrawal_rejected', 'Not approved, with reason', ['amount', 'reason']],
  ['withdrawal_failed', 'Money not sent', ['amount', 'upi']],
  ['gift_packed', 'Gift packed', ['gift']],
  ['gift_shipped', 'Gift shipped, with AWB', ['gift', 'courier', 'awb']],
  ['gift_delivered', 'Gift delivered', ['gift', 'date']],
  ['rank_up', 'New rank', ['name', 'rank', 'benefits', 'next']],
  ['challenge_won', 'Challenge won', ['challenge', 'runs']],
  ['kyc_reminder', 'Monday: add PAN / UPI', ['points']],
  ['password_reset', 'Password reset link', ['link']],
  ['friend_joined', 'Friend joined with your code', ['friend', 'code', 'runs']],
  ['streak_missed', 'Photo streak broke', ['name']],
  ['streak_photo_rejected', 'Work photo not accepted', ['reason']],
];

export default function WhatsApp() {
  useHead('WhatsApp messages', `${TEMPLATES.length} templates · sent through Meta WhatsApp Cloud API`);
  return (
    <>
      <NotConnected what="editing message text, languages and the monthly cost view. Templates are approved in Meta Business Manager; this list shows what the API sends and in which order the {{1}}, {{2}}… values go." />
      <div className="card flush">
        <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
          <table className="tbl cards">
            <thead>
              <tr>
                <th>Template</th>
                <th>Sent when</th>
                <th>Values ({'{{1}}'}, {'{{2}}'} …)</th>
              </tr>
            </thead>
            <tbody>
              {TEMPLATES.map(([name, when, vars]) => (
                <tr key={name}>
                  <td data-l="Template">
                    <span className="row g6 w6 mono">
                      <MessageCircle size={14} color="var(--success-text)" />
                      {name}
                    </span>
                  </td>
                  <td data-l="Sent when">{when}</td>
                  <td data-l="Values" className="t-12 c-sec">
                    {vars.map((v, i) => `{{${i + 1}}} ${v}`).join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="t-12 c-sec">
        Utility ≈ ₹0.12 · marketing ≈ ₹0.80 per message (Meta India rates, check current). Each template needs approval in Hindi, English and Punjabi. <Client>CLIENT: WhatsApp Business number + BSP</Client>
      </p>
    </>
  );
}
