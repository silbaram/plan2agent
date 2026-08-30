/** Deterministically ask only for product-shaping information absent from an idea. */

const OUTCOME_SIGNAL = /\b(?:accept|complete|done|expect|outcome|pass|success|test|verify|works?)\b|결과|동작|완료|성공|검증|테스트|통과|확인/u;
const SCOPE_SIGNAL = /\b(?:exclude|include|minimum|must not|non-goal|only|preserve|scope|without)\b|범위|비목표|제외|포함|최소|(?:^|\s|["'([{])[^\s,.;!?]+만(?=\s|[,.;!?)]|$)|하지 않|건드리지 않|그대로|유지/u;
const USER_SIGNAL = /\b(?:admin|customer|developer|operator|owner|team|user)\b|관리자|고객|개발자|운영자|사용자|팀|초보자/u;
const PROBLEM_SIGNAL = /\b(?:help|need|pain|problem|so that|wants?)\b|문제|불편|필요|돕|할 수 있|원한다/u;
const MATERIAL_BOUNDARY_SUBJECT_SIGNAL = /\b(?:architecture|auth(?:entication|orization)?|compatib|data\s+store|database|db|dependency|external\s+server|integration|oauth|passwords?|payment|permission|personal\s+data|personally\s+identifiable\s+information|pii|privacy|security|stack|storage|third-party|webhook)\b|권한|결제|데이터베이스|\bdb\b|보안|스택|아키텍처|외부\s*(?:서비스|서버|시스템|연동)|연동|인증|로그인\s*방식|비밀번호|개인\s*정보|저장소|호환|웹훅/u;
const MATERIAL_BOUNDARY_CHANGE_SIGNAL = /\b(?:add(?:ed|ing|s)?|adopt(?:ed|ing|s)?|chang(?:e|ed|es|ing)|connect(?:ed|ing|s)?|delet(?:e|ed|es|ing)|deprecat(?:e|ed|es|ing|ion)|disable(?:d|s)?|disabling|drop(?:ped|ping|s)?|enable(?:d|s)?|enabling|expos(?:e|ed|es|ing)|grant(?:ed|ing|s)?|improv(?:e|ed|es|ing|ement)|integrat(?:e|ed|es|ing)|introduc(?:e|ed|es|ing)|migrat(?:e|ed|es|ing|ion)|redesign(?:ed|ing|s)?|remov(?:e|ed|es|ing)|renam(?:e|ed|es|ing)|replac(?:e|ed|es|ing)|revok(?:e|ed|es|ing)|send(?:ing|s|sent)?|set(?:s|ting)?|stor(?:e|ed|es|ing)|switch(?:ed|es|ing)?|transmit(?:s|ted|ting)?|updat(?:e|ed|es|ing))\b|강화|개선|개편|교체|도입|마이그레이션|변경|바꾸|바꿔|부여|삭제|제거|비활성화|보내|연결|연동\s*(?:추가|변경|교체)|업데이트|전송|전환|저장(?!소)|폐기|추가|수정|호환\s*(?:중단|변경)|공개/u;
const MATERIAL_BOUNDARY_ADDITION_SIGNAL = /\badd\b\s+(?:support\s+for\s+)?(?:(?:a|an|new|the|third-party|external|webhook)\s+){0,5}(?:authentication|authorization|integration|oauth|payment|permission|security)\b|(?:권한|결제|보안|외부\s*(?:서비스|시스템|연동)|연동|인증)\s*(?:기능을?\s*)?추가/u;
const MATERIAL_API_SIGNAL = /\b(?:public|external|breaking)\s+api\b|\bapi\b.{0,32}\b(?:contract|endpoint|schema|compatib)\b|\b(?:contract|endpoint|schema|compatib)\b.{0,32}\bapi\b|공개\s*api|api\s*(?:응답\s*)?(?:계약|구조|스키마|엔드포인트|호환)/u;
const MATERIAL_MIGRATION_SIGNAL = /\bmigrat(?:e|ed|es|ing|ion)\b|마이그레이션/u;
const MATERIAL_MIGRATION_EXECUTION_SIGNAL = /\bmigrat(?:e|ed|es|ing)\b|\b(?:apply|execute|perform|run)\s+(?:(?:an?|the|this)\s+)?(?:(?:data|database|schema|storage)\s+)?migration\b|마이그레이션(?:을|를)?\s*(?:진행|실행|적용|수행|배포|시작|완료|하|해)/u;
const MATERIAL_MIGRATION_SCOPE_SUBJECT_SIGNAL = /\b(?:columns?|customers?|data|database|ids?|records?|rows?|schema|tables?|users?)\b|고객|데이터|데이터베이스|레코드|사용자|스키마|아이디|테이블|행/u;
const MATERIAL_MIGRATION_IMPACT_DECISION_SIGNAL = /\b(?:break|delete|discard|drop|keep|lose|overwrite|preserv(?:e|ed|es)|recreate|reset|retain)\b.{0,80}\b(?:client|columns?|compatib|customers?|data|ids?|records?|rows?|schema|tables?|users?)\b|\b(?:client|columns?|compatib|customers?|data|ids?|records?|rows?|schema|tables?|users?)\b.{0,80}\b(?:break|delete|discard|drop|keep|lose|overwrite|preserv(?:e|ed|es)|recreate|reset|retain)\b|(?:고객|데이터|레코드|사용자|스키마|아이디|클라이언트|테이블|호환|행).{0,80}(?:덮어|보존|삭제|손실|유지|재생성|제거|초기화)|(?:덮어|보존|삭제|손실|유지|재생성|제거|초기화).{0,80}(?:고객|데이터|레코드|사용자|스키마|아이디|클라이언트|테이블|호환|행)/u;
const MATERIAL_AUTH_SUBJECT_SIGNAL = /\b(?:auth(?:entication|orization)?|oauth)\b|인증\s*(?:방식|구조|흐름|체계|프로토콜)?|로그인\s*방식/u;
const MATERIAL_AUTH_TRANSITION_SIGNAL = /\b(?:jwt|passkeys?|sessions?)\b|세션|제이더블유티|패스키/u;
const MATERIAL_AUTH_IMPACT_DECISION_SIGNAL = /\b(?:break|expir(?:e|ed|es)|force|invalidate|keep|preserv(?:e|ed|es)|revoke|retain)\b.{0,48}\b(?:auth\s+compatib|existing\s+(?:login|session)s?|login\s+compatib|sessions?)\b|\b(?:auth\s+compatib|existing\s+(?:login|session)s?|login\s+compatib|sessions?)\b.{0,48}\b(?:break|expir(?:e|ed|es)|force|invalidate|keep|preserv(?:e|ed|es)|revoke|retain)\b|\bexisting\s+users?\b.{0,48}\b(?:log\s*in\s+again|reauthenticat(?:e|ed|es))\b|\b(?:log\s*in\s+again|reauthenticat(?:e|ed|es))\b.{0,48}\bexisting\s+users?\b|(?:기존\s*)?(?:로그인\s*(?:상태|세션|호환)|세션|인증\s*호환).{0,48}(?:다시\s*로그인|만료|무효|보존|유지|재로그인|해제)|(?:다시\s*로그인|만료|무효|보존|유지|재로그인|해제).{0,48}(?:기존\s*)?(?:로그인\s*(?:상태|세션|호환)|세션|인증\s*호환)|기존\s*사용자.{0,48}(?:다시\s*로그인|재로그인)|(?:다시\s*로그인|재로그인).{0,48}기존\s*사용자/u;
const MATERIAL_API_IMPACT_DECISION_SIGNAL = /\b(?:break|drop|keep|preserv(?:e|ed|es)|retain|support)\b.{0,48}\b(?:api\s+compatib|contract\s+compatib|existing\s+clients?|response\s+behavio[u]?r)\b|\b(?:api\s+compatib|contract\s+compatib|existing\s+clients?|response\s+behavio[u]?r)\b.{0,48}\b(?:break|drop|keep|preserv(?:e|ed|es)|retain|support)\b|(?:기존\s*)?(?:api\s*호환|계약\s*호환|응답\s*(?:동작|호환)|클라이언트\s*호환).{0,48}(?:깨|보존|불필요|유지|중단|지원|포기|필요하지)|(?:깨|보존|불필요|유지|중단|지원|포기|필요하지).{0,48}(?:기존\s*)?(?:api\s*호환|계약\s*호환|응답\s*(?:동작|호환)|클라이언트\s*호환)|기존\s*클라이언트.{0,48}(?:보존|불필요|유지|중단|지원|포기)|(?:보존|불필요|유지|중단|지원|포기).{0,48}기존\s*클라이언트/u;
const MATERIAL_STORAGE_OR_SENSITIVE_SUBJECT_SIGNAL = /\b(?:data\s+store|database|db|external\s+server|passwords?|personal\s+data|personally\s+identifiable\s+information|pii|privacy|storage)\b|데이터베이스|\bdb\b|외부\s*서버|비밀번호|개인\s*정보|저장소/u;
const MATERIAL_DATA_HANDLING_IMPACT_DECISION_SIGNAL = /\b(?:consent|existing\s+(?:data|passwords?|records?|users?)|password\s+reset|privacy)\b.{0,56}\b(?:delete|discard|drop|keep|migrat(?:e|ed|es|ing)|preserv(?:e|ed|es)|reset|retain|require)\b|\b(?:delete|discard|drop|keep|migrat(?:e|ed|es|ing)|preserv(?:e|ed|es)|reset|retain|require)\b.{0,56}\b(?:consent|existing\s+(?:data|passwords?|records?|users?)|password\s+reset|privacy)\b|(?:기존\s*)?(?:데이터|레코드|비밀번호|개인\s*정보|사용자\s*동의).{0,56}(?:동의|마이그레이션|보존|삭제|유지|재설정|초기화|폐기)|(?:동의|마이그레이션|보존|삭제|유지|재설정|초기화|폐기).{0,56}(?:기존\s*)?(?:데이터|레코드|비밀번호|개인\s*정보|사용자\s*동의)/u;
const MATERIAL_PAYMENT_SUBJECT_SIGNAL = /\bpayments?\b|결제/u;
const MATERIAL_PAYMENT_IMPACT_DECISION_SIGNAL = /\b(?:existing\s+)?(?:payment\s+methods?|payments?|transactions?)\b.{0,48}\b(?:drop|keep|preserv(?:e|ed|es)|retain|support)\b|\b(?:drop|keep|preserv(?:e|ed|es)|retain|support)\b.{0,48}\b(?:existing\s+)?(?:payment\s+methods?|payments?|transactions?)\b|(?:기존\s*)?(?:결제\s*수단|결제|거래).{0,48}(?:보존|유지|중단|지원|포기)|(?:보존|유지|중단|지원|포기).{0,48}(?:기존\s*)?(?:결제\s*수단|결제|거래)/u;
const MATERIAL_GENERIC_BOUNDARY_SUBJECT_SIGNAL = /\b(?:architecture|dependency|integration|permission|security|stack|third-party|webhook)\b|권한|보안|스택|아키텍처|외부\s*(?:서비스|시스템|연동)|연동|웹훅/u;
const MATERIAL_PERMISSION_SUBJECT_SIGNAL = /\bpermissions?\b|권한/u;
const MATERIAL_INTEGRATION_SUBJECT_SIGNAL = /\b(?:integration|third-party|webhook)\b|외부\s*(?:서비스|시스템|연동)|연동|웹훅/u;
const MATERIAL_SECURITY_SUBJECT_SIGNAL = /\bsecurity\b|보안/u;
const MATERIAL_EXPLICIT_UNRESOLVED_SIGNAL = /\b(?:compatib(?:ility)?|preservation)\b.{0,40}\b(?:tbd|to be decided|undecided|unknown|whether)\b|\b(?:tbd|to be decided|undecided|unknown|whether)\b.{0,40}\b(?:compatib(?:ility)?|preserv(?:e|ation))\b|(?:호환성|보존|유지).{0,32}(?:미정|여부|정하지|결정되지|모르)|(?:미정|여부|정하지|결정되지|모르).{0,32}(?:호환성|보존|유지)/u;
const NON_BOUNDARY_DETAIL_SIGNAL = /\b(?:copy|dashboard|documentation|docs?|error\s+message|guide|label|layout|message|readme|regression\s+test|screen|tests?|text|translation|wording)\b|대시보드|레이아웃|화면|오류\s*메시지|안내\s*문구|문구|텍스트|라벨|번역|문서|리드미|테스트/u;
const DIRECT_ENGLISH_BOUNDARY_CHANGE_SIGNAL = /\b(?:adopt(?:ed|ing|s)?|chang(?:e|ed|es|ing)|deprecat(?:e|ed|es|ing)|migrat(?:e|ed|es|ing)|redesign(?:ed|ing|s)?|remov(?:e|ed|es|ing)|renam(?:e|ed|es|ing)|replac(?:e|ed|es|ing)|switch(?:ed|es|ing)?|updat(?:e|ed|es|ing))\s+(?:(?:an?|the|current|existing|public)\s+){0,3}(?:(?:auth(?:entication|orization)?|oauth)\s+(?:flow|method|model|protocol|scheme|system)|oauth\s+authentication|permissions?\s+(?:model|policy|roles?|structure|system)|security\s+(?:boundary|model|policy|structure|system)|webhooks?\s+(?:authentication|contract|endpoint|integration|signature|structure)|(?:public\s+)?api\s+(?:contract|endpoint|response\s+schema|response(?!\s+schema)|schema))(?!\s+(?:copy|documentation|docs?|guide|message|regression\s+tests?|tests?|wording))\b/u;
const DIRECT_ENGLISH_BOUNDARY_TRANSITION_SIGNAL = /\b(?:add(?:ed|ing|s)?|adopt(?:ed|ing|s)?|chang(?:e|ed|es|ing)|connect(?:ed|ing|s)?|deprecat(?:e|ed|es|ing)|disable(?:d|s)?|disabling|drop(?:ped|ping|s)?|enable(?:d|s)?|enabling|improv(?:e|ed|es|ing)|integrat(?:e|ed|es|ing)|introduc(?:e|ed|es|ing)|migrat(?:e|ed|es|ing)|redesign(?:ed|ing|s)?|remov(?:e|ed|es|ing)|renam(?:e|ed|es|ing)|replac(?:e|ed|es|ing)|switch(?:ed|es|ing)?|updat(?:e|ed|es|ing))\s+(?:(?:an?|the|current|existing|new|public)\s+){0,3}(?:(?:sessions?\s+)?auth(?:entication|orization)?|oauth(?:\s+authentication)?|permissions?(?:\s+(?:model|policy|roles?|structure|system))?|(?:[a-z0-9][a-z0-9-]*\s+){0,2}(?:database|payments?(?:\s+(?:integration|method|provider|processor|service|support|system))?|storage(?:\s+(?:backend|provider|service|system))?))(?=\s+(?:from|to|with)\b|\s*$)/u;
const DIRECT_KOREAN_BOUNDARY_CHANGE_SIGNAL = /(?:(?:인증|로그인)\s*(?:방식|구조|흐름|체계|프로토콜)|권한\s*(?:구조|모델|역할|정책|체계)|보안\s*(?:경계|구조|모델|정책|체계)|공개\s*api\s*(?:계약|응답\s*구조|스키마|엔드포인트))(?!\s*(?:설명\s*)?(?:가이드|문구|문서|테스트|텍스트))[^,.;!?\n]{0,64}(?:(?:으로|로)\s*(?:바꾸|바꿔|변경|전환|교체|하|해)|(?:개선|개편|바꾸|바꿔|변경|전환|교체|삭제|제거|폐기))/u;
const CONCRETE_KOREAN_VALUE_CHANGE = /(?:으로|로)\s*(?:변경|교체|전환|번역|수정|바꾸|바꿔|설정|갱신|업데이트|최신화|올리|올려|맞추|맞춰)/u;
const CONCRETE_ENGLISH_VALUE_CHANGE = /\b(?:chang(?:e|ed|es|ing)|convert(?:ed|ing|s)?|replac(?:e|ed|es|ing)|set(?:s|ting)?|switch(?:ed|es|ing)|translat(?:e|ed|es|ing)|updat(?:e|ed|es|ing))\b.{1,80}\b(?:from|to|with)\b/u;
const CONCRETE_ENGLISH_DIRECT_ACTION = /(?:^|[,;.!?]\s*|\b(?:and|but|then)\s+)(?:(?:also|just|only)\s+)?(?:(?:please|kindly)\s+|(?:can|could|would)\s+you\s+(?:please\s+)?|(?:i|we)\s+(?:want|need|would\s+like)\s+to\s+|let(?:'s|\s+us)\s+)?(?:add(?:ed|ing|s)?|chang(?:e|ed|es|ing)|delet(?:e|ed|es|ing)|grant(?:ed|ing|s)?|hid(?:e|den|es|ing)|remov(?:e|ed|es|ing)|renam(?:e|ed|es|ing)|replac(?:e|ed|es|ing)|revok(?:e|ed|es|ing)|show(?:ed|ing|n|s)?|updat(?:e|ed|es|ing))\b/u;
const CONCRETE_KOREAN_DIRECT_ACTION = /(?:을|를|은|는)\s*[^\n,.;!?]{0,60}(?:부여|추가|삭제|제거|수정|변경|바꾸|바꿔|숨기|표시|보여|최신화)(?:해|하|한다|합니다|줘|기|\s|[,.!?]|$)/u;
const UNDERSPECIFIED_DIRECT_ACTION = /^(?:(?:(?:please|kindly)\s+|(?:can|could|would)\s+you\s+(?:please\s+)?|(?:i|we)\s+(?:want|need|would\s+like)\s+to\s+|let(?:'s|\s+us)\s+)?(?:add|change|delete|hide|remove|rename|show|update)\s+(?:(?:a|an|the)\s+)?(?:api|app|application|backend|code|database|feature|frontend|login|module|page|project|screen|server|service|system|ui|website)(?:\s+please)?|(?:api|ui|앱|애플리케이션|로그인|백엔드|서버|서비스|시스템|기능|코드|프로젝트|프론트엔드|페이지|화면)(?:을|를|은|는)?\s*(?:추가|삭제|제거|수정|변경|바꾸|바꿔|숨기|표시|보여|최신화)(?:해|하|한다|합니다|줘|주세요|해줘|해주세요|기)?)[.!]?$/u;
const AUXILIARY_TEST_ACTION_SIGNAL = /\b(?:add|create|update|write)\b[^,.;!?]{0,40}\b(?:regression\s+)?tests?\b|(?:회귀\s*)?테스트(?:를|을)?\s*(?:추가|작성|수정|갱신|보강)/u;
const MATERIAL_CLAUSE_SEPARATOR = /[,.;!?\n]|\b(?:and|but|while)\b|그리고|그러나|반면|하고|하며|하면서|해서|하여|해(?=\s)|하되|다만|지만/u;
const SHARED_ENGLISH_BOUNDARY_ACTION = /^(?:(?:please|kindly)\s+|(?:can|could|would)\s+you\s+(?:please\s+)?|(?:i|we)\s+(?:want|need|would\s+like)\s+to\s+|let(?:'s|\s+us)\s+)?(?:(?:also|just|only)\s+)?(?<action>chang(?:e|ed|es|ing)|improv(?:e|ed|es|ing)|replac(?:e|ed|es|ing)|switch(?:ed|es|ing)?|updat(?:e|ed|es|ing))\s+(?<subjects>[^.;!?\n]+?)(?:\s+please)?[.!?]?$/u;
const SHARED_KOREAN_BOUNDARY_ACTION = /(?:을|를)\s*(?<action>개선|교체|변경|바꾸|바꿔|업데이트|전환)(?:해|하|한다|합니다|줘|주세요|해줘|해주세요)?[.!]?$/u;
const GENERIC_BOUNDARY_VAGUE_SIGNAL = /^(?:(?:please|kindly)\s+)?(?:add(?:ed|ing|s)?|chang(?:e|ed|es|ing)|improv(?:e|ed|es|ing)|remov(?:e|ed|es|ing)|replac(?:e|ed|es|ing)|updat(?:e|ed|es|ing))\s+(?:(?:an?|the|current|existing|new|third-party)\s+){0,4}(?:integration|permissions?(?:\s+(?:model|policy|roles?|structure|system))?|security(?:\s+(?:boundary|model|policy|structure|system))?|webhook\s+integration|payment(?:\s+(?:integration|provider|system))?)(?:\s+please)?$|^(?:권한(?:\s*(?:구조|모델|역할|정책|체계))?|결제(?:\s*(?:연동|제공자|체계))?|보안(?:\s*(?:경계|구조|모델|정책|체계))?|외부\s*연동|연동|웹훅\s*연동)(?:은|는|을|를|이|가)?\s*(?:강화|개선|교체|변경|바꾸|바꿔|삭제|제거|전환|추가|수정)(?:해|하|한다|합니다|줘|주세요|해줘|해주세요)?$/u;
const SPECIFIC_PERMISSION_DECISION_SIGNAL = /\b(?:give|grant|revoke)\b.{0,64}\bpermissions?\b|\b(?:allow|permit)\s+(?:only\s+)?(?:admins?|administrators?|operators?|owners?|teams?|users?)\s+to\s+(?:create|delete|edit|manage|read|view|write)\b|\blet\s+(?:only\s+)?(?:admins?|administrators?|operators?|owners?|teams?|users?)\s+(?:to\s+)?(?:create|delete|edit|manage|read|view|write)\b|\bpermissions?\b.{0,64}\b(?:for|to)\b.{1,48}\b(?:create|delete|edit|manage|read|view|write)\b|(?:관리자|사용자|운영자|소유자|팀|역할).{0,48}에게.{0,48}권한(?:은|는|을|를)?\s*(?:부여|추가|삭제|제거)|에게.{0,48}권한(?:은|는|을|를)?\s*(?:부여|추가|삭제|제거)|권한(?:은|는|을|를)?\s*(?:관리자|사용자|운영자|소유자|팀|역할).{0,24}에게만?\s*(?:허용|부여|제한)/u;
const SPECIFIC_STORAGE_DECISION_SIGNAL = /\bstor(?:e|ing)\s+(?:existing\s+)?(?:data|passwords?|personal\s+data|records?)\s+(?:in|on|using|with)\s+\S+/u;
const SPECIFIC_INTEGRATION_DECISION_SIGNAL = /\b(?:add|connect|integrate|send|transmit)\b.{0,40}\b(?!new\s+third-party\b)(?:[a-z0-9][a-z0-9-]{2,}|https?:\/\/)\b.{0,40}\b(?:integration|webhook|events?)\b|(?:[a-z0-9][a-z0-9-]{2,}|https?:\/\/)[^,.;!?\n]{0,40}(?:integration|webhook|연동)|(?:으로|로)\s*[^,.;!?\n]{0,32}(?:연결|연동|보내|전송)|[^,.;!?\n]{1,32}\s*연동(?:은|는|을|를)?\s*(?:추가|연결)/u;

function normalizedIdea(idea) {
  return String(idea ?? '').trim().toLowerCase();
}

function numberedQuestions(questions) {
  return questions.map((question, index) => ({
    id: `CQ-${index + 1}`,
    ...question,
    status: 'open',
  }));
}

function materialDataMigrationClauseSignal(text) {
  if (!MATERIAL_MIGRATION_SIGNAL.test(text)) return false;
  if (
    MATERIAL_AUTH_SUBJECT_SIGNAL.test(text)
    && !/\b(?:data|database|records?|rows?|schema|tables?)\b|데이터|데이터베이스|레코드|스키마|테이블|행/u.test(text)
  ) return false;
  if (MATERIAL_MIGRATION_SCOPE_SUBJECT_SIGNAL.test(text)) return true;
  return MATERIAL_MIGRATION_EXECUTION_SIGNAL.test(text)
    && !MATERIAL_API_SIGNAL.test(text)
    && !MATERIAL_AUTH_SUBJECT_SIGNAL.test(text);
}

function adjacentDecisionSignal(clauses, boundaryIndex, signal) {
  return clauses
    .slice(Math.max(0, boundaryIndex - 1), boundaryIndex + 2)
    .some((clause) => !NON_BOUNDARY_DETAIL_SIGNAL.test(clause) && signal.test(clause));
}

function materialBoundaryClauses(text) {
  return text
    .split(MATERIAL_CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function sharedActionBoundaryClauses(text) {
  let action;
  let subjects;
  const englishMatch = SHARED_ENGLISH_BOUNDARY_ACTION.exec(text);
  if (englishMatch) {
    ({ action, subjects } = englishMatch.groups);
  } else {
    const koreanMatch = SHARED_KOREAN_BOUNDARY_ACTION.exec(text);
    if (!koreanMatch) return [];
    action = koreanMatch.groups.action;
    subjects = text.slice(0, koreanMatch.index).trim();
  }

  const separator = englishMatch
    ? /\s*,\s*(?:and\s+)?|\s+and\s+/u
    : /\s*,\s*(?:(?:및|그리고)\s+)?|\s+및\s+|[과와]\s+/u;
  const subjectClauses = subjects.split(separator).map((subject) => subject.trim());
  if (
    subjectClauses.length < 2
    || subjectClauses.some((subject) => (
      !MATERIAL_BOUNDARY_SUBJECT_SIGNAL.test(subject)
      || NON_BOUNDARY_DETAIL_SIGNAL.test(subject)
    ))
  ) return [];
  return subjectClauses.map((subject) => `${action} ${subject}`);
}

function materialBoundaryAnalysisClauses(text) {
  const sharedClauses = sharedActionBoundaryClauses(text);
  return sharedClauses.length > 0 ? sharedClauses : materialBoundaryClauses(text);
}

function specifiedGenericBoundaryDecision(clause) {
  if (GENERIC_BOUNDARY_VAGUE_SIGNAL.test(clause)) return false;
  return CONCRETE_KOREAN_VALUE_CHANGE.test(clause)
    || CONCRETE_ENGLISH_VALUE_CHANGE.test(clause)
    || SPECIFIC_PERMISSION_DECISION_SIGNAL.test(clause)
    || SPECIFIC_INTEGRATION_DECISION_SIGNAL.test(clause);
}

function boundarySubjectExplicitlyUnchanged(clause, subjectSignal) {
  const subject = `(?:${subjectSignal.source})`;
  return new RegExp(
    [
      `\\b(?:do not|don't|will not|without)\\s+(?:add|change|replace|touch|changing)\\s+(?:(?:the|approved|current|existing)\\s+){0,3}${subject}`,
      `\\b(?:keep|preserve|retain|use only)\\s+(?:(?:the|approved|current|existing)\\s+){0,3}${subject}(?:\\s+(?:as[- ]is|unchanged))?`,
      `${subject}.{0,24}\\b(?:remain(?:s)? unchanged|will not change)\\b`,
      `${subject}(?:은|는|을|를|이|가)?\\s*(?:그대로\\s*)?(?:유지|변경하지|건드리지|추가하지)`,
    ].join('|'),
    'u',
  ).test(clause);
}

function materialBoundaryClauseIsResolved(clauses, boundaryIndex) {
  const clause = clauses[boundaryIndex];
  if (MATERIAL_EXPLICIT_UNRESOLVED_SIGNAL.test(clause)) return false;
  if (MATERIAL_AUTH_SUBJECT_SIGNAL.test(clause)) {
    if (boundarySubjectExplicitlyUnchanged(clause, MATERIAL_AUTH_SUBJECT_SIGNAL)) return true;
    return concreteDeltaRequest(clause)
      && adjacentDecisionSignal(clauses, boundaryIndex, MATERIAL_AUTH_IMPACT_DECISION_SIGNAL);
  }
  if (MATERIAL_API_SIGNAL.test(clause)) {
    if (boundarySubjectExplicitlyUnchanged(clause, MATERIAL_API_SIGNAL)) return true;
    return concreteDeltaRequest(clause)
      && adjacentDecisionSignal(clauses, boundaryIndex, MATERIAL_API_IMPACT_DECISION_SIGNAL);
  }
  if (materialDataMigrationClauseSignal(clause)) {
    return materialMigrationScopeSignal(clause)
      && adjacentDecisionSignal(
        clauses,
        boundaryIndex,
        MATERIAL_MIGRATION_IMPACT_DECISION_SIGNAL,
      );
  }
  if (MATERIAL_STORAGE_OR_SENSITIVE_SUBJECT_SIGNAL.test(clause)) {
    if (
      boundarySubjectExplicitlyUnchanged(
        clause,
        MATERIAL_STORAGE_OR_SENSITIVE_SUBJECT_SIGNAL,
      )
    ) return true;
    return concreteDeltaRequest(clause)
      && adjacentDecisionSignal(
        clauses,
        boundaryIndex,
        MATERIAL_DATA_HANDLING_IMPACT_DECISION_SIGNAL,
      );
  }
  if (MATERIAL_PAYMENT_SUBJECT_SIGNAL.test(clause)) {
    if (boundarySubjectExplicitlyUnchanged(clause, MATERIAL_PAYMENT_SUBJECT_SIGNAL)) return true;
    return concreteDeltaRequest(clause)
      && adjacentDecisionSignal(
        clauses,
        boundaryIndex,
        MATERIAL_PAYMENT_IMPACT_DECISION_SIGNAL,
      );
  }
  if (boundarySubjectExplicitlyUnchanged(clause, MATERIAL_GENERIC_BOUNDARY_SUBJECT_SIGNAL)) {
    return true;
  }
  return concreteDeltaRequest(clause)
    && specifiedGenericBoundaryDecision(clause);
}

function materialBoundaryIndexes(clauses) {
  return clauses
    .map((clause, index) => (materialBoundaryClauseSignal(clause) ? index : -1))
    .filter((index) => index >= 0);
}

function unresolvedMaterialBoundaryClauses(text) {
  const clauses = materialBoundaryAnalysisClauses(text);
  return materialBoundaryIndexes(clauses)
    .filter((index) => !materialBoundaryClauseIsResolved(clauses, index))
    .map((index) => clauses[index]);
}

function unresolvedMaterialBoundaryClause(text) {
  return unresolvedMaterialBoundaryClauses(text)[0] ?? null;
}

function materialMigrationScopeSignal(text) {
  return MATERIAL_MIGRATION_SIGNAL.test(text)
    && MATERIAL_MIGRATION_SCOPE_SUBJECT_SIGNAL.test(text);
}

function materialBoundaryClauseSignal(text) {
  const directBoundaryChange = DIRECT_ENGLISH_BOUNDARY_CHANGE_SIGNAL.test(text)
    || DIRECT_ENGLISH_BOUNDARY_TRANSITION_SIGNAL.test(text)
    || MATERIAL_BOUNDARY_ADDITION_SIGNAL.test(text)
    || DIRECT_KOREAN_BOUNDARY_CHANGE_SIGNAL.test(text);
  const referenceOnly = NON_BOUNDARY_DETAIL_SIGNAL.test(text)
    && !directBoundaryChange
    && !MATERIAL_MIGRATION_EXECUTION_SIGNAL.test(text);
  if (referenceOnly) return false;
  return (
    MATERIAL_API_SIGNAL.test(text)
    && MATERIAL_BOUNDARY_CHANGE_SIGNAL.test(text)
    && (!NON_BOUNDARY_DETAIL_SIGNAL.test(text) || directBoundaryChange)
  )
    || (
      MATERIAL_MIGRATION_SIGNAL.test(text)
      && (
        !NON_BOUNDARY_DETAIL_SIGNAL.test(text)
        || MATERIAL_MIGRATION_EXECUTION_SIGNAL.test(text)
      )
    )
    || (
      MATERIAL_BOUNDARY_SUBJECT_SIGNAL.test(text)
      && (
        MATERIAL_BOUNDARY_CHANGE_SIGNAL.test(text)
        || MATERIAL_BOUNDARY_ADDITION_SIGNAL.test(text)
        || directBoundaryChange
      )
      && (
        !NON_BOUNDARY_DETAIL_SIGNAL.test(text)
        || directBoundaryChange
      )
    );
}

function materialBoundarySignal(text) {
  return materialBoundaryAnalysisClauses(text)
    .some((clause) => materialBoundaryClauseSignal(clause));
}

function concreteDeltaClause(text) {
  return CONCRETE_KOREAN_VALUE_CHANGE.test(text)
    || CONCRETE_ENGLISH_VALUE_CHANGE.test(text)
    || SPECIFIC_PERMISSION_DECISION_SIGNAL.test(text)
    || SPECIFIC_STORAGE_DECISION_SIGNAL.test(text)
    || materialMigrationScopeSignal(text)
    || (
      (
        CONCRETE_ENGLISH_DIRECT_ACTION.test(text)
        || CONCRETE_KOREAN_DIRECT_ACTION.test(text)
      )
      && !UNDERSPECIFIED_DIRECT_ACTION.test(text.trim())
    );
}

function concreteDeltaRequest(text) {
  const clauses = materialBoundaryClauses(text);
  const primaryClauses = clauses.length > 1
    ? clauses.filter((clause) => !AUXILIARY_TEST_ACTION_SIGNAL.test(clause))
    : clauses;
  return primaryClauses.some((clause) => concreteDeltaClause(clause));
}

function ideaLanguage(text) {
  return /[가-힣]/u.test(text) ? 'ko' : 'en';
}

function materialBoundaryDecisionKind(boundaryClause) {
  if (
    MATERIAL_AUTH_SUBJECT_SIGNAL.test(boundaryClause)
    && (MATERIAL_AUTH_TRANSITION_SIGNAL.test(boundaryClause) || !MATERIAL_API_SIGNAL.test(boundaryClause))
  ) return 'authentication';
  if (MATERIAL_API_SIGNAL.test(boundaryClause)) return 'public_api';
  if (MATERIAL_AUTH_SUBJECT_SIGNAL.test(boundaryClause)) return 'authentication';
  if (materialDataMigrationClauseSignal(boundaryClause)) return 'data_migration';
  if (MATERIAL_STORAGE_OR_SENSITIVE_SUBJECT_SIGNAL.test(boundaryClause)) return 'data_handling';
  if (MATERIAL_PAYMENT_SUBJECT_SIGNAL.test(boundaryClause)) return 'payment';
  if (MATERIAL_PERMISSION_SUBJECT_SIGNAL.test(boundaryClause)) return 'permission';
  if (MATERIAL_INTEGRATION_SUBJECT_SIGNAL.test(boundaryClause)) return 'integration';
  if (MATERIAL_SECURITY_SUBJECT_SIGNAL.test(boundaryClause)) return 'security';
  return 'project_shape';
}

function materialBoundaryQuestion(text, { baseline = false, boundaryClause: selectedClause } = {}) {
  const korean = ideaLanguage(text) === 'ko';
  const boundaryClause = selectedClause ?? unresolvedMaterialBoundaryClause(text) ?? text;
  const boundaryKind = materialBoundaryDecisionKind(boundaryClause);
  if (
    MATERIAL_AUTH_SUBJECT_SIGNAL.test(boundaryClause)
    && (MATERIAL_AUTH_TRANSITION_SIGNAL.test(boundaryClause) || !MATERIAL_API_SIGNAL.test(boundaryClause))
  ) {
    return korean
      ? {
          question: '현재 인증 방식은 유지하고 주변 동작만 개선할까요, 아니면 인증 방식 자체를 변경할까요? 변경한다면 반드시 유지할 호환성을 알려주세요.',
          why_it_matters: '인증 방식 변경은 사용자 경험과 기존 로그인 호환성에 영향을 줄 수 있습니다.',
        }
      : {
          question: 'Should the current authentication stay in place while surrounding behavior improves, or should authentication itself change? If it changes, what compatibility must remain?',
          why_it_matters: 'Changing authentication can affect user experience and existing login compatibility.',
        };
  }
  if (MATERIAL_API_SIGNAL.test(boundaryClause)) {
    return korean
      ? {
          question: '공개 API에서 무엇을 변경하고, 기존 사용자와의 호환성은 어디까지 유지해야 하나요?',
          why_it_matters: '공개 응답이나 계약 변경은 기존 사용자의 동작을 바꿀 수 있습니다.',
        }
      : {
          question: 'What will change in the public API, and which existing clients or response behavior must remain compatible?',
          why_it_matters: 'A public contract change can alter behavior for existing clients.',
        };
  }
  if (MATERIAL_AUTH_SUBJECT_SIGNAL.test(boundaryClause)) {
    return korean
      ? {
          question: '현재 인증 방식은 유지하고 주변 동작만 개선할까요, 아니면 인증 방식 자체를 변경할까요? 변경한다면 반드시 유지할 호환성을 알려주세요.',
          why_it_matters: '인증 방식 변경은 사용자 경험과 기존 로그인 호환성에 영향을 줄 수 있습니다.',
        }
      : {
          question: 'Should the current authentication stay in place while surrounding behavior improves, or should authentication itself change? If it changes, what compatibility must remain?',
          why_it_matters: 'Changing authentication can affect user experience and existing login compatibility.',
        };
  }
  if (materialDataMigrationClauseSignal(boundaryClause)) {
    return korean
      ? {
          question: '실제 데이터 마이그레이션 범위와 반드시 유지해야 할 기존 데이터·호환성을 알려주세요.',
          why_it_matters: '데이터 이동 범위와 보존 조건은 안전하게 추정할 수 없습니다.',
        }
      : {
          question: 'What data will be migrated, and which existing data or compatibility behavior must remain unchanged?',
          why_it_matters: 'The migration scope and preservation requirements cannot be inferred safely.',
        };
  }
  if (MATERIAL_STORAGE_OR_SENSITIVE_SUBJECT_SIGNAL.test(boundaryClause)) {
    return korean
      ? {
          question: '어떤 데이터를 어디에 저장·전송하고, 기존 데이터 보존과 접근·동의 조건은 무엇인가요?',
          why_it_matters: '저장 위치나 민감정보 처리 변경은 데이터 보존과 사용자 안전에 영향을 줄 수 있습니다.',
        }
      : {
          question: 'What data will be stored or sent where, and which preservation, access, or consent requirements must remain?',
          why_it_matters: 'Changing storage or sensitive-data handling can affect data preservation and user safety.',
        };
  }
  if (boundaryKind === 'payment') {
    return korean
      ? {
          question: '어떤 결제 방식이나 제공자를 변경하고, 기존 결제 수단과 진행 중인 거래는 어떻게 유지해야 하나요?',
          why_it_matters: '결제 경계 변경은 기존 결제 수단과 거래 처리에 영향을 줄 수 있습니다.',
        }
      : {
          question: 'Which payment integration, method, or provider will change, and how should existing payment methods and in-flight transactions be handled?',
          why_it_matters: 'Changing a payment boundary can affect existing payment methods and transaction handling.',
        };
  }
  if (boundaryKind === 'integration') {
    return korean
      ? {
          question: '어떤 외부 연동을 변경하고, 기존 이벤트·인증 동작 중 무엇을 유지해야 하나요?',
          why_it_matters: '외부 연동 변경은 기존 이벤트 전달과 인증 동작에 영향을 줄 수 있습니다.',
        }
      : {
          question: 'Which external integration will change, and which existing event or authentication behavior must remain?',
          why_it_matters: 'Changing an external integration can affect existing event delivery and authentication behavior.',
        };
  }
  if (boundaryKind === 'security') {
    return korean
      ? {
          question: '어떤 보안 동작을 변경하고, 기존 보호 조건 중 무엇을 유지해야 하나요?',
          why_it_matters: '보안 경계 변경은 기존 보호 조건과 사용자 안전에 영향을 줄 수 있습니다.',
        }
      : {
          question: 'Which security behavior will change, and which existing protections must remain?',
          why_it_matters: 'Changing a security boundary can affect existing protections and user safety.',
        };
  }
  return korean
    ? {
        question: baseline
          ? '이번 변경으로 실제로 바뀌는 연동·권한·보안 경계와 그대로 유지할 부분을 알려주세요.'
          : '첫 버전에서 반드시 필요한 연동·권한·보안 조건을 알려주세요.',
        why_it_matters: '제품 결과에 큰 영향을 주는 경계는 사용자의 결정 없이 추정할 수 없습니다.',
      }
    : {
        question: baseline
          ? 'Which integration, permission, or security behavior will actually change, and what must remain unchanged?'
          : 'Which integration, permission, or security requirement is mandatory for the first version?',
        why_it_matters: 'A consequential product boundary requires an explicit user decision.',
      };
}

function materialBoundaryQuestions(text, { baseline = false } = {}) {
  if (!materialBoundarySignal(text)) return [];
  const seenKinds = new Set();
  const questions = [];
  for (const boundaryClause of unresolvedMaterialBoundaryClauses(text)) {
    const kind = materialBoundaryDecisionKind(boundaryClause);
    if (seenKinds.has(kind)) continue;
    seenKinds.add(kind);
    questions.push(materialBoundaryQuestion(text, { baseline, boundaryClause }));
  }
  return questions;
}

function intakeQuestionCopy(text) {
  if (ideaLanguage(text) === 'ko') {
    return {
      deltaOutcome: {
        question: '이 변경이 완료됐다고 판단할 수 있는 결과나 확인 방법은 무엇인가요?',
        why_it_matters: '기존 동작은 유지되므로 빠진 완료 기준만 확인하면 됩니다.',
      },
      deltaScope: {
        question: '이번에 바꿀 최소 범위와 그대로 유지할 주변 동작을 알려주세요.',
        why_it_matters: '승인된 기존 동작을 다시 설명하게 하지 않고 변경 범위만 정합니다.',
      },
      greenfieldUser: {
        question: '첫 버전은 누구를 위한 것이고, 그 사용자의 어떤 핵심 문제를 해결해야 하나요?',
        why_it_matters: '대상 사용자와 해결할 문제가 아직 분명하지 않습니다.',
      },
      greenfieldScope: {
        question: '첫 버전에서 반드시 보여야 할 최소 결과와 이번에 제외할 범위는 무엇인가요?',
        why_it_matters: '첫 버전의 결과와 범위를 정해야 개발 계획을 확정할 수 있습니다.',
      },
    };
  }
  return {
    deltaOutcome: {
      question: 'What observable outcome or check will show that this change is complete?',
      why_it_matters: 'Only a missing completion signal is needed; approved baseline behavior remains in force.',
    },
    deltaScope: {
      question: 'What is the smallest scope for this change, including anything adjacent that should stay unchanged?',
      why_it_matters: 'This bounds the delta without asking the user to restate the approved baseline.',
    },
    greenfieldUser: {
      question: 'Who is this for, and what core problem should the first version solve for them?',
      why_it_matters: 'The product user or problem is not explicit enough to confirm the first scope.',
    },
    greenfieldScope: {
      question: 'What is the smallest first-version outcome, and what should remain outside it?',
      why_it_matters: 'The first-version boundary or observable outcome is still material and unstated.',
    },
  };
}

function localizedQuestion(copy) {
  return {
    question: copy.question,
    why_it_matters: copy.why_it_matters,
  };
}

export function deltaClarifyingQuestions(idea) {
  const text = normalizedIdea(idea);
  const questions = [];
  const copy = intakeQuestionCopy(text);
  const boundaryQuestions = materialBoundaryQuestions(text, { baseline: true });
  if (boundaryQuestions.length) {
    return numberedQuestions(boundaryQuestions.map((boundary) => ({
      decision_kind: 'material_boundary',
      ...boundary,
      blocks: [
        'spec.product.constraints',
        'spec.product.external_integrations',
        'spec.implementation.architecture',
        'spec.implementation.interfaces',
        'spec.implementation.dependencies',
      ],
    })));
  }
  const concreteDelta = concreteDeltaRequest(text);
  if (!OUTCOME_SIGNAL.test(text) && !concreteDelta) {
    questions.push({
      ...localizedQuestion(copy.deltaOutcome),
      blocks: ['spec.product.success_criteria', 'spec.implementation.verification'],
    });
  }
  if (!SCOPE_SIGNAL.test(text) && !concreteDelta) {
    questions.push({
      ...localizedQuestion(copy.deltaScope),
      blocks: ['spec.product.goals', 'spec.product.non_goals', 'spec.product.core_flows'],
    });
  }
  return numberedQuestions(questions);
}

export function greenfieldClarifyingQuestions(idea) {
  const text = normalizedIdea(idea);
  const questions = [];
  const copy = intakeQuestionCopy(text);
  if (!USER_SIGNAL.test(text) || !PROBLEM_SIGNAL.test(text)) {
    questions.push({
      ...localizedQuestion(copy.greenfieldUser),
      blocks: ['spec.product.problem', 'spec.product.target_users'],
    });
  }
  if (!OUTCOME_SIGNAL.test(text) || !SCOPE_SIGNAL.test(text)) {
    questions.push({
      ...localizedQuestion(copy.greenfieldScope),
      blocks: [
        'spec.product.goals',
        'spec.product.non_goals',
        'spec.product.core_flows',
        'spec.product.success_criteria',
        'spec.implementation.verification',
      ],
    });
  }
  for (const boundary of materialBoundaryQuestions(text)) {
    questions.push({
      decision_kind: 'material_boundary',
      ...boundary,
      blocks: [
        'spec.product.constraints',
        'spec.product.external_integrations',
        'spec.implementation.architecture',
        'spec.implementation.interfaces',
        'spec.implementation.dependencies',
      ],
    });
  }
  return numberedQuestions(questions);
}
