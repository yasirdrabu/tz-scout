// Curated segment proposals the mock Claude returns for Taazaa's six productized offerings.
// Live mode generates these from the offering record instead. Values are 0 to 10 ratings; committee
// and cycle are raw (10 = very complex / very long) and are inverted when scored.

export type MockSegment = {
  key: string;
  name: string;
  buyer: string;
  problem: string;
  industry: string;
  keywords: string[];
  expectedDealDollars: number;
  /** pain, urgency, ability to pay, delivery fit, committee complexity, cycle length */
  v: [number, number, number, number, number, number];
  painWhy: string;
  urgencyWhy: string;
};

const s = (
  key: string,
  buyer: string,
  problem: string,
  industry: string,
  keywords: string[],
  expectedDealDollars: number,
  v: MockSegment["v"],
  painWhy: string,
  urgencyWhy: string,
): MockSegment => ({ key, name: `${buyer} ${problem}`, buyer, problem, industry, keywords, expectedDealDollars, v, painWhy, urgencyWhy });

export const SEGMENT_LIBRARY: Record<string, MockSegment[]> = {
  "ai-opportunity-map": [
    s("om-cre-ops", "COOs at 200 to 1,500 person commercial real estate owner-operators", "with board pressure on AI and no starting point", "Commercial real estate", ["ai for commercial real estate", "real estate ai strategy"], 10000, [8, 8, 8, 9, 4, 3], "Boards are asking for an AI plan and the COO owns the answer.", "Budget season and lender scrutiny force a plan this quarter."),
    s("om-mf-reporting", "Operations VPs at multifamily managers with 5,000+ units", "rebuilding owner reports by hand every month", "Property management", ["property management ai", "automate owner reporting"], 10000, [8, 7, 7, 9, 4, 3], "Ten to forty analyst hours a month go into owner reports.", "New owner contracts demand faster reporting."),
    s("om-health-ops", "COOs at regional healthcare services groups", "told to do something with AI and unsure where", "Healthcare services", ["ai in healthcare operations", "healthcare ai roadmap"], 10000, [7, 7, 7, 7, 6, 5], "Staffing gaps make every manual hour expensive.", "Payer and staffing pressure, but compliance slows decisions."),
    s("om-3pl", "VPs of Operations at 3PLs and regional carriers", "where dispatch and quoting are still manual", "Logistics", ["logistics ai", "freight quoting automation"], 10000, [8, 6, 6, 9, 3, 3], "Quote turnaround loses loads to faster brokers.", "Rate volatility makes slow quoting costly now."),
    s("om-prof-services", "Managing partners at 100 to 500 person accounting and consulting firms", "losing billable hours to admin", "Professional services", ["ai for accounting firms", "consulting firm automation"], 10000, [6, 5, 7, 7, 6, 4], "Non-billable admin quietly erodes margin.", "Busy season creates a window, not a deadline."),
    s("om-insurance-agency", "COOs at insurance agencies and MGAs", "with intake and quoting buried in email", "Insurance", ["insurance agency ai", "mga automation"], 10000, [7, 6, 6, 8, 5, 4], "Submissions sit in inboxes for days.", "Carrier appetite changes reward speed."),
    s("om-pe-portco", "Operating partners at lower mid-market PE firms", "needing an AI plan across portfolio companies", "Private equity", ["private equity ai value creation", "portfolio company ai"], 25000, [7, 8, 9, 7, 6, 4], "LPs ask every fund about AI value creation.", "Hold periods and exit stories make this urgent."),
    s("om-mfg", "Operations leaders at $50 to 300M manufacturers", "quoting and scheduling on spreadsheets", "Manufacturing", ["manufacturing ai", "quote automation manufacturing"], 10000, [7, 5, 6, 6, 5, 6], "Estimators are the bottleneck on every bid.", "Retirements are forcing the issue, slowly."),
  ],
  "agentready-diagnostic": [
    s("ar-health-cio", "CIOs at hospital groups and clinic networks", "with staff already using AI tools and HIPAA exposure", "Healthcare services", ["hipaa ai compliance", "healthcare ai governance"], 10000, [9, 8, 8, 9, 6, 4], "Shadow AI use with patient data is a live breach risk.", "Audits and the board want an answer before the next incident."),
    s("ar-bank-ciso", "CISOs at regional banks and credit unions", "asked to approve AI pilots without a control framework", "Financial services", ["ai risk management banking", "model risk ai"], 10000, [8, 7, 8, 7, 8, 6], "Examiners will ask how AI is governed.", "Exam cycles create hard dates."),
    s("ar-insurer-compliance", "Compliance leads at insurers and MGAs", "facing state AI rules and model reviews", "Insurance", ["insurance ai regulation", "ai governance insurance"], 10000, [8, 8, 7, 7, 7, 5], "State AI bulletins require documented controls.", "Filing deadlines and market conduct exams."),
    s("ar-proptech-cto", "CTOs at PropTech platforms", "whose enterprise landlords demand AI security reviews", "Commercial real estate", ["proptech ai security", "ai security questionnaire"], 10000, [8, 9, 7, 9, 4, 3], "Deals stall on AI questions in security reviews.", "Every stalled renewal has a date on it."),
    s("ar-legal-it", "IT directors at 100 to 500 lawyer firms", "where attorneys paste client data into chatbots", "Legal services", ["law firm ai policy", "legal ai governance"], 10000, [8, 7, 7, 8, 6, 5], "Privilege and client confidentiality are at stake.", "Client outside counsel guidelines now ask about AI."),
    s("ar-saas-data", "Heads of Data at B2B SaaS companies", "answering AI governance questions in every security questionnaire", "Software", ["ai governance saas", "soc 2 ai controls"], 10000, [7, 8, 7, 8, 4, 3], "Questionnaires block deals without a credible answer.", "Quarter-end deals depend on it."),
    s("ar-eu-exposure", "CIOs at US mid-market firms with EU customers", "facing EU AI Act obligations", "Professional services", ["eu ai act compliance", "ai act readiness"], 10000, [7, 9, 8, 7, 7, 5], "Fines run to a share of global revenue.", "High-risk obligations are enforceable from August 2026."),
    s("ar-healthtech", "VPs of Engineering at health tech vendors", "selling into hospitals that require AI controls", "Healthcare services", ["health tech ai compliance", "hospital ai vendor review"], 10000, [8, 8, 7, 9, 5, 4], "Hospital procurement now has an AI section.", "Pipeline is waiting on the answer."),
  ],
  "fde-sprint": [
    s("fde-cre-lease", "Asset managers at commercial real estate owners", "abstracting leases by hand", "Commercial real estate", ["lease abstraction ai", "automate lease abstraction"], 10000, [8, 6, 7, 9, 3, 2], "Each lease takes hours and errors cost rent.", "Acquisitions bring hundreds of leases at once."),
    s("fde-prior-auth", "Revenue cycle directors at clinic groups", "running prior authorization by phone and fax", "Healthcare services", ["prior authorization automation", "prior auth ai"], 10000, [9, 7, 7, 8, 5, 4], "Denials and delays hit cash and patient care.", "Payer rule changes keep adding volume."),
    s("fde-freight-quote", "Pricing managers at freight brokers", "quoting by email and spreadsheet", "Logistics", ["freight quote automation", "ai freight pricing"], 10000, [8, 7, 6, 9, 2, 2], "Slow quotes lose loads every day.", "Every lost quote is revenue gone today."),
    s("fde-legal-intake", "Operations directors at plaintiff law firms", "with paralegal-heavy intake", "Legal services", ["legal intake automation", "ai client intake law firm"], 10000, [8, 6, 6, 10, 3, 2], "Intake takes hours per matter.", "Case volume is up and paralegals are scarce."),
    s("fde-claims-fnol", "Claims operations leaders at MGAs", "re-keying first notice of loss", "Insurance", ["fnol automation", "claims intake ai"], 10000, [7, 6, 7, 8, 5, 4], "Adjusters lose a day to data entry.", "Catastrophe season spikes volume."),
    s("fde-ap-invoices", "Controllers at multi-entity companies", "with an invoice processing backlog", "Financial services", ["invoice processing automation", "ap automation ai"], 10000, [7, 6, 7, 9, 4, 3], "Late payments and missed discounts add up.", "Month-end close pressure every month."),
    s("fde-nemt-dispatch", "Dispatch leaders at transport and NEMT providers", "matching trips to drivers by hand", "Transportation", ["nemt dispatch software", "ai dispatch optimization"], 10000, [8, 7, 6, 10, 3, 2], "Missed trips cost contracts.", "State contracts audit on-time rates."),
    s("fde-work-orders", "Maintenance directors at property managers", "triaging work orders by phone", "Property management", ["work order automation", "maintenance request ai"], 10000, [7, 6, 6, 8, 3, 2], "Residents churn over slow repairs.", "Renewal season makes it visible."),
  ],
  "smart-space-poc": [
    s("ss-re-fund-memos", "Investment teams at real estate funds", "assembling deal memos by hand", "Commercial real estate", ["deal memo automation", "real estate investment ai"], 35000, [7, 6, 9, 9, 6, 5], "Analysts spend days per memo.", "Deal flow returns as rates settle."),
    s("ss-pe-diligence", "Corporate development and PE deal teams", "writing diligence notes from data rooms", "Private equity", ["due diligence ai", "data room ai"], 45000, [8, 7, 9, 9, 6, 4], "Diligence windows are tight and costly.", "Each live deal has a close date."),
    s("ss-vendor-risk", "Third-party risk teams at regulated mid-market firms", "reviewing vendor packets by hand", "Financial services", ["vendor risk automation", "third party risk ai"], 35000, [7, 7, 8, 9, 7, 6], "Review queues delay every vendor.", "Regulators expect faster, documented reviews."),
    s("ss-clinical-protocols", "Clinical operations leaders", "who need an assistant clinicians can trust", "Healthcare services", ["clinical ai assistant", "hospital knowledge assistant"], 45000, [8, 6, 8, 8, 8, 7], "Clinicians lose time hunting for protocols.", "Staffing shortages, but long approvals."),
    s("ss-fnb-sensory", "R&D leads at food and beverage companies", "writing evaluation memos from panel data", "Food and beverage", ["sensory evaluation software", "r&d ai food"], 30000, [6, 5, 8, 9, 5, 5], "Memos repeat the same work every launch.", "Launch calendars set the pace."),
    s("ss-medical-affairs", "Medical affairs teams at specialty pharma", "producing literature reviews", "Life sciences", ["literature review ai", "medical affairs ai"], 45000, [7, 6, 9, 8, 7, 7], "Reviews take weeks of expert time.", "Submission timelines drive demand."),
    s("ss-cs-briefs", "Customer success leaders at B2B SaaS", "walking into renewals without an account brief", "Software", ["customer success ai", "account brief automation"], 25000, [6, 6, 7, 8, 4, 3], "Churn hides in unread tickets and notes.", "Renewal dates create urgency."),
  ],
  "company-brain": [
    s("cb-re-ceo", "CEOs at $50 to 500M real estate operators", "whose know-how lives in three people's heads", "Commercial real estate", ["company knowledge base ai", "ai for real estate operators"], 45000, [8, 6, 9, 8, 5, 5], "Key-person risk on every critical process.", "Succession and growth plans surface it."),
    s("cb-prof-services", "Presidents of professional services firms", "losing institutional knowledge to turnover", "Professional services", ["knowledge management ai", "institutional knowledge"], 35000, [7, 5, 8, 8, 5, 5], "Every departure resets client knowledge.", "Turnover is constant, urgency is not."),
    s("cb-health-multisite", "COOs at multi-site healthcare services groups", "standardizing how sites operate", "Healthcare services", ["multi site operations ai", "healthcare sop ai"], 45000, [8, 6, 8, 7, 7, 6], "Every site runs differently.", "Acquisitions add new sites each quarter."),
    s("cb-distribution", "CEOs at family-owned distributors", "facing a generational handoff", "Distribution", ["distributor ai", "succession knowledge capture"], 35000, [7, 6, 7, 7, 4, 5], "Founders hold pricing and supplier knowledge.", "Handoff dates are set."),
    s("cb-msp", "Owners of IT managed services firms", "with runbooks scattered across tools", "IT services", ["msp knowledge base ai", "runbook automation"], 25000, [7, 6, 6, 9, 3, 3], "Senior techs answer the same questions daily.", "Margins squeeze every quarter."),
    s("cb-contractors", "COOs at regional general contractors", "where estimating knowledge walks out with retirees", "Construction", ["construction estimating ai", "contractor knowledge"], 35000, [7, 6, 7, 6, 5, 6], "Bids depend on a few estimators.", "Retirements are scheduled."),
    s("cb-franchise", "Operations VPs at multi-unit franchise groups", "enforcing playbooks across locations", "Franchise", ["franchise operations ai", "franchise playbook"], 35000, [6, 5, 7, 7, 5, 5], "Consistency slips location by location.", "New openings keep coming."),
  ],
  "modernization-blueprint": [
    s("mb-carrier-access", "Operations VPs at regional carriers", "running dispatch on an Access database", "Logistics", ["replace access database", "legacy dispatch system"], 10000, [9, 8, 6, 10, 3, 3], "One crash stops the business.", "The one person who maintains it is retiring."),
    s("mb-pm-vendor-gone", "COOs at property managers", "on a custom system the vendor stopped supporting", "Property management", ["legacy property management software", "replace custom software"], 10000, [8, 7, 7, 9, 4, 4], "No vendor means no fixes.", "Security and integration gaps grow monthly."),
    s("mb-clinic-scheduling", "IT directors at specialty clinic groups", "with homegrown scheduling tools", "Healthcare services", ["legacy healthcare software modernization", "replace scheduling system"], 10000, [8, 6, 7, 8, 6, 5], "Workarounds cause double bookings.", "Compliance reviews flag the risk."),
    s("mb-policy-admin", "CIOs at small carriers and MGAs", "on an aging policy admin system", "Insurance", ["policy administration modernization", "legacy insurance system"], 10000, [8, 6, 8, 7, 7, 7], "Product launches wait on the old system.", "Long decisions, but real pressure."),
    s("mb-mfg-erp", "Plant controllers at manufacturers", "with a heavily customized legacy ERP", "Manufacturing", ["legacy erp replacement", "erp modernization"], 10000, [7, 5, 7, 6, 7, 7], "Customizations block every upgrade.", "Support end dates loom, slowly."),
    s("mb-nonprofit", "Executive directors at large nonprofits", "on donated, unsupported software", "Nonprofit", ["nonprofit software modernization", "replace legacy donor system"], 10000, [7, 5, 4, 8, 5, 5], "Staff fight the system daily.", "Grant cycles open budget windows."),
    s("mb-gov-contractor", "Program leads at government contractors", "with VB6 case management tools", "Government services", ["vb6 modernization", "legacy case management"], 10000, [8, 6, 7, 7, 8, 8], "Contracts require modern security.", "Recompete dates force it."),
    s("mb-retiring-dev", "Owners of $20 to 200M companies", "whose only developer is retiring", "Professional services", ["custom software rescue", "legacy code takeover"], 10000, [9, 9, 6, 9, 2, 2], "All system knowledge sits with one person.", "The retirement date is on the calendar."),
  ],
};

/** Words in the buyer's own voice for message tests. Keyed by segment key. */
export const STATEMENT_LIBRARY: Record<string, { problems: string[]; outcomes: string[] }> = {
  "om-cre-ops": {
    problems: [
      "Our board keeps asking for an AI plan and I don't know where to start.",
      "Every vendor pitches AI, but none of them know how a building actually runs.",
      "We tried a pilot last year and nobody uses it.",
      "My team spends Fridays rebuilding the same leasing reports.",
      "I can't tell which AI ideas would pay back and which are noise.",
      "We have data in five systems and none of them talk.",
      "I'm the one who has to explain our AI plan to lenders.",
    ],
    outcomes: [
      "A ranked list of AI moves for our portfolio, with the first one ready to build.",
      "Know in two weeks which AI ideas pay back and which to drop.",
      "One page I can hand the board that answers the AI question.",
      "Get our asset managers out of spreadsheets and back into deals.",
      "Start with one win the whole company can see in 90 days.",
      "A fixed price plan, not an open-ended consulting bill.",
      "Leasing reports that build themselves every Monday.",
    ],
  },
  "om-mf-reporting": {
    problems: [
      "We rebuild owner reports by hand every single month.",
      "My regional managers spend more time in Excel than on site.",
      "Every new owner wants their report a different way.",
      "We bought software that promised automation and still export to Excel.",
      "I can't add units without adding analysts.",
      "Our data is right, it just takes a week to pull together.",
    ],
    outcomes: [
      "Owner reports out the door on day two, not day ten.",
      "Add 5,000 units without adding a reporting analyst.",
      "Let regional managers run properties, not spreadsheets.",
      "A clear list of where AI saves us hours, priced and ranked.",
      "Give every owner their own report without extra work.",
      "Close the month faster than our competitors.",
    ],
  },
  "ar-health-cio": {
    problems: [
      "I know clinicians are pasting patient notes into chatbots.",
      "The board wants AI, compliance wants none of it, I'm in the middle.",
      "We have no way to see which AI tools staff already use.",
      "Our AI policy is a paragraph nobody has read.",
      "One bad AI incident and we're in the news.",
      "Vendors say their AI is HIPAA compliant and I can't verify it.",
    ],
    outcomes: [
      "A clear go, fix first, or not ready answer on AI in two weeks.",
      "Know exactly where our AI risk is and how to close it.",
      "Say yes to AI projects without betting the license on it.",
      "A remediation plan the board and compliance both sign.",
      "Score our readiness across six areas and fix the weakest first.",
      "Controls that let clinicians use AI safely, not just a ban.",
    ],
  },
  "ar-proptech-cto": {
    problems: [
      "Enterprise landlords stall our deals on AI security questions.",
      "Every security review now has an AI section we can't fill in.",
      "We ship AI features faster than we can govern them.",
      "I'm answering the same AI questionnaire for the tenth time.",
      "One customer's legal team asked for our AI controls and we froze.",
      "Our AI story sounds good until procurement reads it.",
    ],
    outcomes: [
      "Pass the AI section of every security review the first time.",
      "A governance answer we can paste into any questionnaire.",
      "Close the enterprise deals stuck in security review.",
      "Ship AI features with controls customers can see.",
      "Know where we stand in two weeks, with a fixed fee.",
      "Turn AI governance into a reason to buy, not a blocker.",
    ],
  },
  "fde-legal-intake": {
    problems: [
      "Our paralegals spend three hours on intake for every new case.",
      "Good cases wait in the queue while we type up forms.",
      "We hire paralegals and they leave because the work is data entry.",
      "Intake errors come back to bite us at discovery.",
      "We tried legal AI tools and they didn't fit how we work.",
      "I can't take more cases without hiring more people.",
    ],
    outcomes: [
      "Intake done in 45 minutes instead of three hours.",
      "Take more cases with the team we already have.",
      "A working intake flow in our own system, not a demo.",
      "Let paralegals do legal work, not data entry.",
      "One workflow fixed for real in weeks, at a fixed price.",
      "Clean case files from day one.",
    ],
  },
  "mb-carrier-access": {
    problems: [
      "Our whole dispatch runs on an Access database from 2009.",
      "The one person who understands our system is retiring next year.",
      "If that server dies, we stop moving freight.",
      "We can't hook our system up to anything new.",
      "Every vendor quote to replace it is a black box.",
      "We've been patching this thing for a decade.",
    ],
    outcomes: [
      "A fixed price for the rebuild before we commit a dollar more.",
      "A modern dispatch system on our own cloud, built in releases.",
      "Stop depending on one person to keep the business running.",
      "Know exactly what Release 1 costs and when it ships.",
      "Keep running while the new system comes online.",
      "If you can't fixed-price Release 1, the blueprint is free.",
    ],
  },
  "mb-retiring-dev": {
    problems: [
      "The only developer who knows our system is retiring.",
      "Nobody else can read the code that runs our business.",
      "We put off replacing it for years and now we're out of time.",
      "Every change takes months because one person does it all.",
      "I don't know what our system actually does under the hood.",
      "We got quotes and none of them answered what it will really cost.",
    ],
    outcomes: [
      "Capture what the system does before the knowledge walks out.",
      "A map of the old system and a fixed price for the new one.",
      "A team that owns the code, not one person.",
      "A rebuild plan we can budget for, not guess at.",
      "Move off the old system without stopping the business.",
      "Two weeks to a clear plan, at a fixed fee.",
    ],
  },
};
