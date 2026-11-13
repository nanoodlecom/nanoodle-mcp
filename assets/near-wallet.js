/*! Nanoodle browser assets. Wallet dependency licenses: /near-wallet.LICENSE.txt */
var Qe=Object.create;var $e=Object.defineProperty;var et=Object.getOwnPropertyDescriptor;var tt=Object.getOwnPropertyNames;var nt=Object.getPrototypeOf,st=Object.prototype.hasOwnProperty;var c=(s,e)=>()=>{try{return e||s((e={exports:{}}).exports,e),e.exports}catch(t){throw e=0,t}};var ot=(s,e,t,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let o of tt(e))!st.call(s,o)&&o!==t&&$e(s,o,{get:()=>e[o],enumerable:!(n=et(e,o))||n.enumerable});return s};var rt=(s,e,t)=>(t=s!=null?Qe(nt(s)):{},ot(e||!s||!s.__esModule?$e(t,"default",{value:s,enumerable:!0}):t,s));var X=c($=>{"use strict";Object.defineProperty($,"__esModule",{value:!0});$.LocalStorage=void 0;var Y=class{async get(e){return typeof window>"u"?null:localStorage.getItem(e)}async set(e,t){typeof window>"u"||localStorage.setItem(e,t)}async remove(e){typeof window>"u"||localStorage.removeItem(e)}};$.LocalStorage=Y});var je=c(Z=>{"use strict";Object.defineProperty(Z,"__esModule",{value:!0});Z.encodeBase58=at;var Ne="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";function at(s){if(s.length===0)return"";let e=0,t=0;for(;t<s.length&&s[t]===0;)e++,t++;let n=[0];for(;t<s.length;t++){let r=s[t];for(let a=0;a<n.length;++a)r+=n[a]<<8,n[a]=r%58,r=r/58|0;for(;r>0;)n.push(r%58),r=r/58|0}for(;n.length>0&&n[n.length-1]===0;)n.pop();let o="";for(let r=0;r<e;r++)o+=Ne[0];for(let r=n.length-1;r>=0;--r)o+=Ne[n[r]];return o}});var C=c(N=>{"use strict";Object.defineProperty(N,"__esModule",{value:!0});N.nearActionsToConnectorActions=void 0;var it=je(),lt=s=>{try{return JSON.parse(new TextDecoder().decode(s))}catch{return s}},ct=s=>s.enum!=null?s.enum==="fullAccess":"fullAccess"in s,dt=s=>s.enum!=null?s.enum==="AccountId":"AccountId"in s,ut=s=>s.map(e=>{if("type"in e)return e;if(e.signedDelegate)throw new Error("SignedDelegate actions cannot be sent through the wallet connector; wallets sign delegates via signDelegateActions");if(e.functionCall)return{type:"FunctionCall",params:{methodName:e.functionCall.methodName,args:lt(e.functionCall.args),gas:e.functionCall.gas.toString(),deposit:e.functionCall.deposit.toString()}};if(e.deployGlobalContract)return{type:"DeployGlobalContract",params:{code:e.deployGlobalContract.code,deployMode:dt(e.deployGlobalContract.deployMode)?"AccountId":"CodeHash"}};if(e.createAccount)return{type:"CreateAccount"};if(e.useGlobalContract){let t=e.useGlobalContract.contractIdentifier;return{type:"UseGlobalContract",params:{contractIdentifier:t.AccountId!=null?{accountId:t.AccountId}:{codeHash:(0,it.encodeBase58)(t.CodeHash)}}}}if(e.deployContract)return{type:"DeployContract",params:{code:e.deployContract.code}};if(e.deleteAccount)return{type:"DeleteAccount",params:{beneficiaryId:e.deleteAccount.beneficiaryId}};if(e.deleteKey)return{type:"DeleteKey",params:{publicKey:e.deleteKey.publicKey.toString()}};if(e.transfer)return{type:"Transfer",params:{deposit:e.transfer.deposit.toString()}};if(e.stake)return{type:"Stake",params:{stake:e.stake.stake.toString(),publicKey:e.stake.publicKey.toString()}};if(e.addKey){let{permission:t}=e.addKey.accessKey,n;if(t.functionCall)n={receiverId:t.functionCall.receiverId,allowance:t.functionCall.allowance?.toString(),methodNames:t.functionCall.methodNames};else if(ct(t))n="FullAccess";else throw new Error("Unsupported access-key permission on AddKey: only functionCall and fullAccess can be sent through the wallet connector (pass a ConnectorAction otherwise)");return{type:"AddKey",params:{publicKey:e.addKey.publicKey.toString(),accessKey:{nonce:Number(e.addKey.accessKey.nonce),permission:n}}}}throw new Error("Unsupported action type")});N.nearActionsToConnectorActions=ut});var I=c(k=>{"use strict";Object.defineProperty(k,"__esModule",{value:!0});k.isGasKeyAction=void 0;k.assertGasKeyActionsSupported=wt;var ht=s=>s.type==="TransferToGasKey"||s.type==="WithdrawFromGasKey"||s.type==="AddKey"&&s.params.gasKeyInfo!=null;k.isGasKeyAction=ht;function wt(s,e,t){if(s?.gasKeys)return;let n=e.filter(k.isGasKeyAction).map(o=>o.type);if(n.length!==0)throw new Error(`${t} does not advertise gas-key support (manifest features.gasKeys), so ${[...new Set(n)].join(", ")} cannot be sent through it; a wallet that does not know gasKeyInfo could add a plain key instead. Sign locally with a full-access key, or use a wallet whose manifest sets features.gasKeys.`)}});var T=c(j=>{"use strict";Object.defineProperty(j,"__esModule",{value:!0});j.uuid4=void 0;var gt=()=>typeof window<"u"&&typeof window.crypto<"u"&&typeof window.crypto.randomUUID=="function"?window.crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(s){let e=Math.random()*16|0;return(s==="x"?e:e&3|8).toString(16)});j.uuid4=gt});var ne=c(W=>{"use strict";Object.defineProperty(W,"__esModule",{value:!0});W.ParentFrameWallet=void 0;var Q=C(),ee=I(),ft=T(),te=class{connector;manifest;constructor(e,t){this.connector=e,this.manifest=t}callParentFrame(e,t){let n=(0,ft.uuid4)();return window.parent.postMessage({type:"near-wallet-injected-request",id:n,method:e,params:t},"*"),new Promise((o,r)=>{let a=i=>{i.data.type==="near-wallet-injected-response"&&i.data.id===n&&(window.removeEventListener("message",a),i.data.success?o(i.data.result):r(i.data.error))};window.addEventListener("message",a)})}async signIn(e){let t=await this.callParentFrame("near:signIn",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey});return Array.isArray(t)?t:[t]}async signInAndSignMessage(e){let t=await this.callParentFrame("near:signInAndSignMessage",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey,messageParams:e.messageParams});return Array.isArray(t)?t:[t]}async signOut(e){let t={...e,network:e?.network??this.connector.network};await this.callParentFrame("near:signOut",t)}async getAccounts(e){let t={...e,network:e?.network??this.connector.network};return this.callParentFrame("near:getAccounts",t)}async signAndSendTransaction(e){let t=(0,Q.nearActionsToConnectorActions)(e.actions);(0,ee.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n={...e,actions:t,network:e.network??this.connector.network};return this.callParentFrame("near:signAndSendTransaction",n)}async signAndSendTransactions(e){let t=e.transactions.map(o=>({actions:(0,Q.nearActionsToConnectorActions)(o.actions),receiverId:o.receiverId}));(0,ee.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(o=>o.actions),this.manifest.name);let n={...e,transactions:t,network:e.network??this.connector.network};return this.callParentFrame("near:signAndSendTransactions",n)}async signMessage(e){let t={...e,network:e.network??this.connector.network};return this.callParentFrame("near:signMessage",t)}async signDelegateActions(e){let t={...e,delegateActions:e.delegateActions.map(n=>({...n,actions:(0,Q.nearActionsToConnectorActions)(n.actions)})),network:e.network||this.connector.network};return(0,ee.assertGasKeyActionsSupported)(this.manifest.features,t.delegateActions.flatMap(n=>n.actions),this.manifest.name),this.callParentFrame("near:signDelegateActions",t)}};W.ParentFrameWallet=te});var se=c(O=>{"use strict";Object.defineProperty(O,"__esModule",{value:!0});O.parseUrl=void 0;var pt=s=>{try{return new URL(s)}catch{return null}};O.parseUrl=pt});var Te=c(q=>{"use strict";Object.defineProperty(q,"__esModule",{value:!0});q.copyText=void 0;var mt=async s=>{try{await navigator.clipboard.writeText(s);return}catch{}let e=document.createElement("textarea");e.value=s,e.setAttribute("readonly",""),e.style.position="fixed",e.style.opacity="0",document.body.appendChild(e),e.select();try{if(!document.execCommand("copy"))throw new Error("Copy failed")}finally{e.remove()}};q.copyText=mt});var Oe=c(p=>{"use strict";Object.defineProperty(p,"__esModule",{value:!0});p.openExternalLink=p.openTelegramLink=p.isTelegramMiniApp=void 0;var oe=()=>{let s=window?.Telegram?.WebApp;return!s||!s.platform||s.platform==="unknown"?null:s},yt=()=>{try{return location.hash.includes("tgWebAppData")?!0:!!sessionStorage.getItem("__telegram__initParams")}catch{return!1}},bt=()=>typeof window>"u"?!1:!!oe()||!!window.TelegramWebviewProxy||yt();p.isTelegramMiniApp=bt;var We=(s,e)=>{let t=window.TelegramWebviewProxy;if(t?.postEvent)return t.postEvent(s,JSON.stringify(e));let n=window.external;if(n&&"notify"in n)return n.notify(JSON.stringify({eventType:s,eventData:e}));window.parent!==window&&window.parent.postMessage(JSON.stringify({eventType:s,eventData:e}),"https://web.telegram.org")},xt=s=>{let e=oe();if(e)return e.openTelegramLink(s.toString());We("web_app_open_tg_link",{path_full:s.pathname+s.search})};p.openTelegramLink=xt;var vt=s=>{let e=oe();if(e)return e.openLink(s.toString());We("web_app_open_link",{url:s.toString()})};p.openExternalLink=vt});var ae=c(L=>{"use strict";Object.defineProperty(L,"__esModule",{value:!0});L.EventEmitter=void 0;var re=class{events={};on(e,t){this.events[e]||(this.events[e]=[]),this.events[e].push(t)}emit(e,t){this.events[e]?.forEach(n=>n(t))}off(e,t){this.events[e]=this.events[e]?.filter(n=>n!==t)}once(e,t){let n=o=>{t(o),this.off(e,n)};this.on(e,n)}removeAllListeners(e){e?delete this.events[e]:this.events={}}};L.EventEmitter=re});var D=c(K=>{"use strict";Object.defineProperty(K,"__esModule",{value:!0});K.escapeHtml=qe;K.html=kt;function qe(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}var ie=Symbol("htmlTag");function kt(s,...e){let t=s[0];for(let n=0;n<e.length;n++){for(let o of Array.isArray(e[n])?e[n]:[e[n]]){let r=o?.[ie]?o[ie]:qe(String(o??""));t+=r}t+=s[n+1]}return Object.freeze({[ie]:t,get html(){return t}})}});var Le=c(F=>{"use strict";Object.defineProperty(F,"__esModule",{value:!0});F.css=void 0;var At=s=>`
${s} * {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
  -ms-overflow-style: none; 
  scrollbar-width: none; 
  color: #fff;
}

${s} *::-webkit-scrollbar { 
  display: none;
}

${s} p,
${s} h1,
${s} h2,
${s} h3,
${s} h4,
${s} h5,
${s} h6 {
  margin: 0;
}

${s} .modal-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 100000000;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    transition: opacity 0.2s ease-in-out;
}

@media (max-width: 600px) {
  ${s} .modal-container {
    justify-content: flex-end;
  }
}

${s} .modal-content {
  display: flex;
  flex-direction: column;
  align-items: center;

  max-width: 420px;
  max-height: 615px;
  width: 100%;
  border-radius: 24px;
  background: #0d0d0d;
  border: 1.5px solid rgba(255, 255, 255, 0.1);
  transition: transform 0.2s ease-in-out;
}

@media (max-width: 600px) {
  ${s} .modal-content {
    max-width: 100%;
    width: 100%;
    max-height: 80%;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border: none;
    border-top: 1.5px solid rgba(255, 255, 255, 0.1);
  }
}


${s} .modal-header {
  display: flex;
  padding: 16px;
  gap: 16px;
  align-self: stretch;
  align-items: center;
  justify-content: center;
  position: relative;
}

${s} .modal-header button {
  position: absolute;
  right: 16px;
  top: 16px;
  width: 32px;
  height: 32px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.2s ease-in-out;
  border: none;
  background: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

${s} .modal-header button:hover {
  background: rgba(255, 255, 255, 0.04);
}
  
${s} .modal-header p {
  color: #fff;
  text-align: center;
  font-size: 24px;
  font-style: normal;
  font-weight: 600;
  line-height: normal;
  margin: 0;
}


${s} .modal-body {
  display: flex;
  padding: 16px;
  flex-direction: column;
  align-items: flex-start;
  text-align: center;
  gap: 8px;
  overflow: auto;

  border-radius: 24px;
  background: rgba(255, 255, 255, 0.08);
  width: 100%;
  flex: 1;
}

${s} .modal-body textarea {
  width: 100%;
  padding: 12px;
  border-radius: 12px;
  background: #0d0d0d;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.1);
  outline: none;
  font-size: 16px;
  transition: background 0.2s ease-in-out;
  font-family: monospace;
  font-size: 12px;
}

${s} .modal-body button {
  width: 100%;
  padding: 12px;
  border-radius: 12px;
  background: #fff;
  color: #000;
  border: none;
  cursor: pointer;
  font-size: 16px;
  transition: background 0.2s ease-in-out;
  margin-top: 16px;
}

${s} .footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 16px 24px;
  color: #fff;
  gap: 12px;
}

${s} .modal-body p {
  color: rgba(255, 255, 255, 0.9);
  text-align: center;
  font-size: 16px;
  font-style: normal;
  font-weight: 500;
  line-height: normal;
  letter-spacing: -0.8px;
}

${s} .footer img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

${s} .get-wallet-link {
  color: rgba(255, 255, 255, 0.5);
  text-align: center;
  font-size: 16px;
  font-style: normal;
  font-weight: 500;
  margin-left: auto;
  text-decoration: none;
  transition: color 0.2s ease-in-out;
  cursor: pointer;
}
  
${s} .get-wallet-link:hover {
  color: rgba(255, 255, 255, 1);
}


${s} .connect-item {
  display: flex;
  padding: 8px;
  align-items: center;
  gap: 12px;
  align-self: stretch;
  cursor: pointer;

  transition: background 0.2s ease-in-out;
  border-radius: 24px;
}

${s} .connect-item img {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  object-fit: cover;
  flex-shrink: 0;
}

${s} .connect-item-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  text-align: left;
  flex: 1;
  margin-top: -2px;
}

${s} .connect-item-info .wallet-address {
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
  font-style: normal;
  font-weight: 400;
  line-height: normal;
}

${s} .connect-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

${s} .connect-item img {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  object-fit: cover;
}

${s} .connect-item p {
  color: rgba(255, 255, 255, 0.9);
  text-align: center;
  font-size: 18px;
  font-style: normal;
  font-weight: 600;
  line-height: normal;
  letter-spacing: -0.36px;
  margin: 0;
}
`;F.css=At});var ce=c(U=>{"use strict";Object.defineProperty(U,"__esModule",{value:!0});U.Popup=void 0;var St=Le(),Ct=D(),Ke=`n${Math.random().toString(36).substring(2,15)}`;if(typeof document<"u"){let s=document.createElement("style");s.textContent=(0,St.css)(`.${Ke}`),document.head.append(s)}var le=class{delegate;isClosed=!1;root=document.createElement("div");state={};constructor(e){this.delegate=e}get dom(){return(0,Ct.html)``}disposables=[];addListener(e,t,n){let o=typeof e=="string"?this.root.querySelector(e):e;o&&(o.addEventListener(t,n),this.disposables.push(()=>o.removeEventListener(t,n)))}handlers(){this.disposables.forEach(o=>o()),this.disposables=[];let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.onclick=o=>o.stopPropagation(),e.onclick=()=>{this.delegate.onReject(),this.destroy()};let n=o=>{o.key==="Escape"&&(this.delegate.onReject(),this.destroy())};document.addEventListener("keydown",n),this.disposables.push(()=>document.removeEventListener("keydown",n))}update(e){this.state={...this.state,...e},this.root.innerHTML=this.dom.html,this.handlers()}create({show:e=!0}){this.root.className=`${Ke} hot-connector-popup`,this.root.style.display="none",this.root.innerHTML=this.dom.html,document.body.append(this.root),this.handlers();let t=this.root.querySelector(".modal-container"),n=this.root.querySelector(".modal-content");n.style.transform="translateY(50px)",t.style.opacity="0",e&&setTimeout(()=>this.show(),10)}show(){let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.style.transform="translateY(50px)",e.style.opacity="0",this.root.style.display="block",setTimeout(()=>{t.style.transform="translateY(0)",e.style.opacity="1"},100)}hide(){let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.style.transform="translateY(50px)",e.style.opacity="0",setTimeout(()=>{this.root.style.display="none"},200)}destroy(){this.isClosed||(this.isClosed=!0,this.disposables.forEach(e=>e()),this.disposables=[],this.hide(),setTimeout(()=>{this.root.remove()},200))}};U.Popup=le});var De=c(R=>{"use strict";Object.defineProperty(R,"__esModule",{value:!0});R.IframeWalletPopup=void 0;var de=D(),It=ce(),ue=class extends It.Popup{delegate;constructor(e){super(e),this.delegate=e}handlers(){super.handlers(),this.addListener("button","click",()=>this.delegate.onApprove())}create(){super.create({show:!1}),this.root.querySelector(".modal-body").appendChild(this.delegate.iframe),this.delegate.iframe.style.width="100%",this.delegate.iframe.style.height="720px",this.delegate.iframe.style.border="none"}get footer(){if(!this.delegate.footer)return"";let{icon:e,heading:t}=this.delegate.footer;return(0,de.html)`
      <div class="footer">
        ${e?(0,de.html)`<img src="${e}" alt="${t}" />`:""}
        <p>${t}</p>
      </div>
    `}get dom(){return(0,de.html)`<div class="modal-container">
      <div class="modal-content">
        <div class="modal-body" style="padding: 0; overflow: auto;"></div>
        ${this.footer}
      </div>
    </div>`}};R.IframeWalletPopup=ue});var Fe=c(G=>{"use strict";Object.defineProperty(G,"__esModule",{value:!0});G.NEAR_CONNECT_VERSION=void 0;G.NEAR_CONNECT_VERSION="0.12.0"});var Ue=c(he=>{"use strict";Object.defineProperty(he,"__esModule",{value:!0});var Pt=Fe();async function _t(s){let e=await s.executor.getAllStorage(),t=s.executor.connector.providers,n=s.executor.manifest,o=s.id,r=s.code.replaceAll(".localStorage",".sandboxedLocalStorage").replaceAll("window.top","window.selector").replaceAll("window.open","window.selector.open"),a=s.cspNonce?` nonce="${s.cspNonce.replace(/[^A-Za-z0-9+/=]/g,"")}"`:"";return`
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body>
      <div id="root"></div>

      <style>
        :root {
          --background-color: rgb(40, 40, 40);
          --text-color: rgb(255, 255, 255);
          --border-color: rgb(209, 209, 209);
        }

        * {
          font-family: system-ui, Avenir, Helvetica, Arial, sans-serif
        }

        body, html {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
          background-color: var(--background-color);
          color: var(--text-color);
        }

        #root {
          display: none;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          width: 100vw;
          background: radial-gradient(circle at center, #2c2c2c 0%, #1a1a1a 100%);
          text-align: center;
        }

        #root * {
          box-sizing: border-box;
          font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
          line-height: 1.5;
          color-scheme: light dark;
          color: rgb(255, 255, 255);
          font-synthesis: none;
          text-rendering: optimizeLegibility;
          -webkit-font-smoothing: antialiased;
        }

        .prompt-container img {
          width: 100px;
          height: 100px;
          object-fit: cover;
          border-radius: 12px;
        }

        .prompt-container h1 {
          margin: 0;
          font-size: 24px;
          font-weight: 600;
          margin-top: 16px;
        }

        .prompt-container p {
          margin: 0;
          font-size: 16px;
          font-weight: 500;
          color: rgb(209, 209, 209);
        }

        .prompt-container button {
          background-color: #131313;
          border: none;
          border-radius: 12px;
          padding: 12px 24px;
          cursor: pointer;
          transition: border-color 0.25s;
          color: #fff;
          outline: none;
          font-size: 14px;
          font-weight: 500;
          font-family: inherit;
          margin-top: 16px;
        }
      </style>


      <script${a}>
      window.sandboxedLocalStorage = (() => {
        let storage = ${JSON.stringify(e)}

        return {
          setItem: function(key, value) {
            window.selector.storage.set(key, value)
            storage[key] = value || '';
          },
          getItem: function(key) {
            return key in storage ? storage[key] : null;
          },
          removeItem: function(key) {
            window.selector.storage.remove(key)
            delete storage[key];
          },
          get length() {
            return Object.keys(storage).length;
          },
          key: function(i) {
            const keys = Object.keys(storage);
            return keys[i] || null;
          },
        };
      })();

      const showPrompt = async (args) => {
        const root = document.getElementById("root");   
        root.style.display = "flex";
        root.innerHTML = \`
          <div class="prompt-container">
            <img src="${n.icon}" />
            <h1>${n.name}</h1>
            <p>\${args.title}</p>
            <button>\${args.button}</button>
          </div>
        \`;

        return new Promise((resolve) => {
          root.querySelector("button")?.addEventListener("click", () => {
            root.innerHTML = "";
            resolve(true);
          });
        });
      }

      class ProxyWindow {
        constructor(url, features) {
          this.closed = false;
          this.windowIdPromise = window.selector.call("open", { url, features });

          window.addEventListener("message", async (event) => {            
            if (event.data.origin !== "${o}") return;
            if (!event.data.method?.startsWith("proxy-window:")) return;
            const method = event.data.method.replace("proxy-window:", "");
            if (method === "closed" && event.data.windowId === await this.id()) this.closed = true;
          });
        } 

        async id() {
          return await this.windowIdPromise;
        }

        async focus() {
          await window.selector.call("panel.focus", { windowId: await this.id() });
        }

        async postMessage(data) {
          window.selector.call("panel.postMessage", { windowId: await this.id(), data });
        }

        async close() {
          await window.selector.call("panel.close", { windowId: await this.id() });
        }
      }

      window.selector = {
        wallet: null,
        location: "${window.location.href}",
        nearConnectVersion: "${Pt.NEAR_CONNECT_VERSION}",
        
        outerHeight: ${window.outerHeight},
        screenY: ${window.screenY},
        outerWidth: ${window.outerWidth},
        screenX: ${window.screenX},

        providers: {
          mainnet: ${JSON.stringify(t.mainnet)},
          testnet: ${JSON.stringify(t.testnet)},
        },

        uuid() {
          return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          });
        },

        walletConnect: {
          connect(params) {
            return window.selector.call("walletConnect.connect", params);
          },
          disconnect(params) {
            return window.selector.call("walletConnect.disconnect", params);
          },
          request(params) {
            return window.selector.call("walletConnect.request", params);
          },
          getProjectId() {
            return window.selector.call("walletConnect.getProjectId", {});
          },
          getSession() {
            return window.selector.call("walletConnect.getSession", {});
          },
        },
      
        async ready(wallet) {
          wallet.manifest = ${JSON.stringify(n)};
          window.parent.postMessage({ method: "wallet-ready", origin: "${o}" }, "*");
          window.selector.wallet = wallet;
        },

        async call(method, params) {
          const id = window.selector.uuid();
          window.parent.postMessage({ method, params, id, origin: "${o}" }, "*");

          return new Promise((resolve, reject) => {
            const handler = (event) => {
              if (event.data.id !== id || event.data.origin !== "${o}") return;
              window.removeEventListener("message", handler);

              if (event.data.status === "failed") reject(event.data.result);
              else resolve(event.data.result);
            };

            window.addEventListener("message", handler);
          });
        },

        panelClosed(windowId) {
          window.parent.postMessage({ 
            method: "panel.closed", 
            origin: "${o}", 
            result: { windowId } 
          }, "*");
        },

        open(url, _, params) {
          return new ProxyWindow(url, params)
        },

        external(entity, key, ...args) {
          return window.selector.call("external", { entity, key, args: args || [] });
        },

        openNativeApp(url) {
          return window.selector.call("open.nativeApp", { url });
        },

        ui: {
          async whenApprove(options) {
            window.selector.ui.showIframe();
            await showPrompt(options);
            window.selector.ui.hideIframe();
          },

          async showIframe() {
            return await window.selector.call("ui.showIframe");
          },

          async hideIframe() {
            return await window.selector.call("ui.hideIframe");
          },
        },

        storage: {
          async set(key, value) {
            await window.selector.call("storage.set", { key, value });
          },
      
          async get(key) {
            return await window.selector.call("storage.get", { key });
          },
      
          async remove(key) {
            await window.selector.call("storage.remove", { key });
          },

          async keys() {
            return await window.selector.call("storage.keys", {});
          },
        },
      };

      // Clipboard API often rejects inside the sandbox (Android WebView), copy through the dApp page then.
      // Plain assignment to navigator.clipboard is a no-op (getter on the prototype), so redefine the method
      const clipboard = navigator.clipboard || {};
      const nativeWriteText = clipboard.writeText ? clipboard.writeText.bind(clipboard) : null;
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        value: async (text) => {
          try {
            if (nativeWriteText) return await nativeWriteText(text);
          } catch {}
          await window.selector.call("clipboard.writeText", { text });
        },
      });
      if (!navigator.clipboard) Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

      window.addEventListener("message", async (event) => {
        if (event.data.origin !== "${o}") return;
        if (!event.data.method?.startsWith("wallet:")) return;
      
        const wallet = window.selector.wallet;
        const method = event.data.method.replace("wallet:", "");
        const payload = { id: event.data.id, origin: "${o}", method };
      
        if (wallet == null || typeof wallet[method] !== "function") {
          const data = { ...payload, status: "failed", result: "Method not found" };
          window.parent.postMessage(data, "*");
          return;
        }
        
        try {
          const result = await wallet[method](event.data.params);
          window.parent.postMessage({ ...payload, status: "success", result }, "*");
        } catch (error) {
          const data = { ...payload, status: "failed", result: error };
          window.parent.postMessage(data, "*");
        }
      });
      <\/script>

      <script type="module"${a}>${r}<\/script>
    </body>
  </html>
    `}he.default=_t});var Re=c(P=>{"use strict";var Et=P&&P.__importDefault||function(s){return s&&s.__esModule?s:{default:s}};Object.defineProperty(P,"__esModule",{value:!0});var Mt=ae(),$t=T(),Nt=De(),jt=Et(Ue()),we=class{executor;origin;disposed=!1;iframe=document.createElement("iframe");events=new Mt.EventEmitter;popup;handler;readyPromiseResolve;readyPromise=new Promise(e=>{this.readyPromiseResolve=e});constructor(e,t,n,o){this.executor=e,this.origin=(0,$t.uuid4)(),this.handler=a=>{a.data.origin===this.origin&&(a.data.method==="wallet-ready"&&this.readyPromiseResolve(),n(this,a))},window.addEventListener("message",this.handler);let r=[];this.executor.checkPermissions("usb")&&r.push("usb *;"),this.executor.checkPermissions("hid")&&r.push("hid *;"),this.executor.checkPermissions("clipboardRead")&&r.push("clipboard-read;"),this.executor.checkPermissions("clipboardWrite")&&r.push("clipboard-write;"),this.executor.checkPermissions("bluetooth")&&r.push("bluetooth *;"),this.iframe.allow=r.join(" "),this.iframe.setAttribute("sandbox","allow-scripts"),(0,jt.default)({id:this.origin,executor:this.executor,code:t,cspNonce:o}).then(a=>{this.executor.connector.logger?.log("Iframe code injected"),this.iframe.srcdoc=a}),this.popup=new Nt.IframeWalletPopup({footer:this.executor.connector.footerBranding,iframe:this.iframe,onApprove:()=>{},onReject:()=>{this.disposed=!0,window.removeEventListener("message",this.handler),this.events.emit("close",{}),this.popup.destroy()}}),this.popup.create()}on(e,t){this.events.on(e,t)}show(){this.popup.show()}hide(){this.popup.hide()}postMessage(e){if(this.disposed)return;let t=this.iframe.contentWindow;if(!t)throw new Error(`Iframe not loaded for ${e?.method??"unknown method"}`);t.postMessage({...e,origin:this.origin},"*")}dispose(){this.disposed=!0,window.removeEventListener("message",this.handler),this.popup.destroy()}};P.default=we});var Ge=c(_=>{"use strict";var Tt=_&&_.__importDefault||function(s){return s&&s.__esModule?s:{default:s}};Object.defineProperty(_,"__esModule",{value:!0});var m=se(),fe=T(),Wt=Te(),ge=Oe(),Ot=Tt(Re()),qt=(0,fe.uuid4)(),pe=class{connector;manifest;activePanels={};storageSpace;constructor(e,t){this.connector=e,this.manifest=t,this.storageSpace=t.id}checkPermissions(e,t){if(e==="walletConnect")return!!this.manifest.permissions.walletConnect;if(e==="external"){let n=this.manifest.permissions.external;return!n||!t?.entity?!1:n.includes(t.entity)}if(e==="allowsOpen"){let n=(0,m.parseUrl)(t?.url||""),o=this.manifest.permissions.allowsOpen;return!n||!o||!Array.isArray(o)||o.length===0?!1:o.some(a=>{let i=(0,m.parseUrl)(a);return!(!i||n.protocol!==i.protocol||i.hostname&&n.hostname!==i.hostname||i.pathname&&i.pathname!=="/"&&n.pathname!==i.pathname)})}return this.manifest.permissions[e]}assertPermissions(e,t,n){if(!this.checkPermissions(t,n.data.params))throw e.postMessage({...n.data,status:"failed",result:"Permission denied"}),new Error("Permission denied")}_onMessage=async(e,t)=>{let n=r=>{e.postMessage({...t.data,status:"success",result:r})},o=r=>{e.postMessage({...t.data,status:"failed",result:r})};if(t.data.method==="ui.showIframe"){e.show(),n(null);return}if(t.data.method==="ui.hideIframe"){e.hide(),n(null);return}if(t.data.method==="storage.set"){this.assertPermissions(e,"storage",t),localStorage.setItem(`${this.storageSpace}:${t.data.params.key}`,t.data.params.value),n(null);return}if(t.data.method==="storage.get"){this.assertPermissions(e,"storage",t);let r=localStorage.getItem(`${this.storageSpace}:${t.data.params.key}`);n(r);return}if(t.data.method==="storage.keys"){this.assertPermissions(e,"storage",t);let r=Object.keys(localStorage).filter(a=>a.startsWith(`${this.storageSpace}:`));n(r);return}if(t.data.method==="storage.remove"){this.assertPermissions(e,"storage",t),localStorage.removeItem(`${this.storageSpace}:${t.data.params.key}`),n(null);return}if(t.data.method==="panel.focus"){let r=this.activePanels[t.data.params.windowId];r&&r.focus(),n(null);return}if(t.data.method==="panel.postMessage"){let r=this.activePanels[t.data.params.windowId];r&&r.postMessage(t.data.params.data,"*"),n(null);return}if(t.data.method==="panel.close"){let r=this.activePanels[t.data.params.windowId];r&&r.close(),delete this.activePanels[t.data.params.windowId],n(null);return}if(t.data.method==="walletConnect.connect"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).connect(t.data.params);a.approval(),n({uri:a.uri})}catch(r){o(r)}return}if(t.data.method==="walletConnect.getProjectId"){if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");this.assertPermissions(e,"walletConnect",t);let r=await this.connector.walletConnect;n(r.core.projectId);return}if(t.data.method==="walletConnect.disconnect"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).disconnect(t.data.params);n(a)}catch(r){o(r)}return}if(t.data.method==="walletConnect.getSession"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let r=await this.connector.walletConnect,a=r.session.keys[r.session.keys.length-1],i=a?r.session.get(a):null;n(i?{topic:i.topic,namespaces:i.namespaces}:null)}catch(r){o(r)}return}if(t.data.method==="walletConnect.request"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).request(t.data.params);n(a)}catch(r){o(r)}return}if(t.data.method==="clipboard.writeText"){this.assertPermissions(e,"clipboardWrite",t);try{await(0,Wt.copyText)(t.data.params.text),n(null)}catch(r){o(r)}return}if(t.data.method==="external"){this.assertPermissions(e,"external",t);try{let{entity:r,key:a,args:i}=t.data.params,l=r.split(".").reduce((v,Ze)=>v[Ze],window);r==="nightly.near"&&a==="signTransaction"&&(i[0].encode=()=>i[0]);let d=typeof l[a]=="function"?await l[a](...i||[]):l[a];n(d)}catch(r){o(r)}return}if(t.data.method==="open"){this.assertPermissions(e,"allowsOpen",t);let r=(0,m.parseUrl)(t.data.params.url);if(r&&r.protocol==="https:"&&(0,ge.isTelegramMiniApp)()){r.hostname==="t.me"?(0,ge.openTelegramLink)(r):(0,ge.openExternalLink)(r),n(null);return}let a=window.open(t.data.params.url,"_blank",t.data.params.features),i=a?(0,fe.uuid4)():null,l=d=>{let v=(0,m.parseUrl)(t.data.params.url);v&&v.origin===d.origin&&e.postMessage(d.data)};if(n(i),window.addEventListener("message",l),a&&i){this.activePanels[i]=a;let d=setInterval(()=>{if(!a?.closed)return;window.removeEventListener("message",l);let v={method:"proxy-window:closed",windowId:i};delete this.activePanels[i],clearInterval(d);try{e.postMessage(v)}catch{}},500)}return}if(t.data.method==="open.nativeApp"){this.assertPermissions(e,"allowsOpen",t);let r=(0,m.parseUrl)(t.data.params.url);if(!r||["https","http","javascript:","file:","data:","blob:","about:"].includes(r.protocol))throw o("Invalid URL"),new Error("[open.nativeApp] Invalid URL");let i=document.createElement("iframe");i.src=t.data.params.url,i.style.display="none",document.body.appendChild(i),e.postMessage({...t.data,status:"success",result:null});return}};actualCode=null;async checkNewVersion(e,t){if(this.actualCode)return this.connector.logger?.log("New version of code already checked"),this.actualCode;let n=(0,m.parseUrl)(e.manifest.executor);if(n||(n=(0,m.parseUrl)(location.origin+e.manifest.executor)),!n)throw new Error("Invalid executor URL");n.searchParams.set("nonce",qt);let o=await fetch(n.toString()).then(r=>{if(!r.ok)throw new Error(`Failed to load executor: ${r.status}`);return r.text()});return this.connector.logger?.log("New version of code fetched"),this.actualCode=o,o===t?(this.connector.logger?.log("New version of code is the same as the current version"),this.actualCode):(await this.connector.db.setItem(`${this.manifest.id}:${this.manifest.version}`,o).then(()=>this.connector.logger?.log("New version of code saved to cache")).catch(r=>this.connector.logger?.log("Failed to cache new version of code",r)),o)}async loadCode(){let e=await this.connector.db.getItem(`${this.manifest.id}:${this.manifest.version}`).catch(()=>null);this.connector.logger?.log("Code loaded from cache",e!==null);let t=this.checkNewVersion(this,e);return e||await t}async call(e,t){this.connector.logger?.log("Add to queue",e,t),this.connector.logger?.log("Calling method",e,t);let n=await this.loadCode();this.connector.logger?.log("Code loaded, preparing");let o=new Ot.default(this,n,this._onMessage,this.connector.cspNonce);this.connector.logger?.log("Code loaded, iframe initialized"),await o.readyPromise,this.connector.logger?.log("Iframe ready");let r=(0,fe.uuid4)();return new Promise((a,i)=>{try{let l=d=>{d.data.id!==r||d.data.origin!==o.origin||(o.dispose(),window.removeEventListener("message",l),this.connector.logger?.log("postMessage",{result:d.data,request:{method:e,params:t}}),d.data.status==="failed"?i(d.data.result):a(d.data.result))};window.addEventListener("message",l),o.postMessage({method:e,params:t,id:r}),o.on("close",()=>i(new Error("Wallet closed")))}catch(l){this.connector.logger?.log("Iframe error",l),i(l)}})}async getAllStorage(){let e=Object.keys(localStorage).filter(n=>n.startsWith(`${this.storageSpace}:`)),t={};for(let n of e)t[n.replace(`${this.storageSpace}:`,"")]=localStorage.getItem(n);return t}async clearStorage(){let e=Object.keys(localStorage).filter(t=>t.startsWith(`${this.storageSpace}:`));for(let t of e)localStorage.removeItem(t)}};_.default=pe});var be=c(y=>{"use strict";var Lt=y&&y.__importDefault||function(s){return s&&s.__esModule?s:{default:s}};Object.defineProperty(y,"__esModule",{value:!0});y.SandboxWallet=void 0;var me=C(),ye=I(),Kt=Lt(Ge()),H=class{connector;manifest;executor;constructor(e,t){this.connector=e,this.manifest=t,this.executor=new Kt.default(e,t)}async signIn(e){return this.executor.call("wallet:signIn",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey})}async signInAndSignMessage(e){return this.executor.call("wallet:signInAndSignMessage",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey,messageParams:e.messageParams})}async signOut(e){let t={...e,network:e?.network??this.connector.network};await this.executor.call("wallet:signOut",t),await this.executor.clearStorage()}async getAccounts(e){let t={...e,network:e?.network??this.connector.network};return this.executor.call("wallet:getAccounts",t)}async signAndSendTransaction(e){let t=(0,me.nearActionsToConnectorActions)(e.actions);(0,ye.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n={...e,actions:t,network:e.network??this.connector.network};return this.executor.call("wallet:signAndSendTransaction",n)}async signAndSendTransactions(e){let t=e.transactions.map(o=>({actions:(0,me.nearActionsToConnectorActions)(o.actions),receiverId:o.receiverId}));(0,ye.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(o=>o.actions),this.manifest.name);let n={...e,transactions:t,network:e.network??this.connector.network};return this.executor.call("wallet:signAndSendTransactions",n)}async signMessage(e){let t={...e,network:e.network??this.connector.network};return this.executor.call("wallet:signMessage",t)}async signDelegateActions(e){let t={...e,delegateActions:e.delegateActions.map(n=>({...n,actions:(0,me.nearActionsToConnectorActions)(n.actions)})),network:e.network??this.connector.network};return(0,ye.assertGasKeyActionsSupported)(this.manifest.features,t.delegateActions.flatMap(n=>n.actions),this.manifest.name),this.executor.call("wallet:signDelegateActions",t)}};y.SandboxWallet=H;y.default=H});var Ae=c(z=>{"use strict";Object.defineProperty(z,"__esModule",{value:!0});z.InjectedWallet=void 0;var xe=C(),ve=I(),ke=class{connector;wallet;constructor(e,t){this.connector=e,this.wallet=t}get manifest(){return this.wallet.manifest}async signIn({addFunctionCallKey:e,network:t}){return this.wallet.signIn({network:t??this.connector.network,addFunctionCallKey:e})}async signInAndSignMessage(e){return this.wallet.signInAndSignMessage({network:e?.network??this.connector.network,addFunctionCallKey:e.addFunctionCallKey,messageParams:e.messageParams})}async signOut(e){await this.wallet.signOut({network:e?.network??this.connector.network})}async getAccounts(e){return this.wallet.getAccounts({network:e?.network??this.connector.network})}async signAndSendTransaction(e){let t=(0,xe.nearActionsToConnectorActions)(e.actions);(0,ve.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n=e.network??this.connector.network,o=await this.wallet.signAndSendTransaction({...e,actions:t,network:n});if(!o)throw new Error("No result from wallet");return Array.isArray(o.transactions)?o.transactions[0]:o}async signAndSendTransactions(e){let t=e.network??this.connector.network,n=e.transactions.map(r=>({actions:(0,xe.nearActionsToConnectorActions)(r.actions),receiverId:r.receiverId}));(0,ve.assertGasKeyActionsSupported)(this.manifest.features,n.flatMap(r=>r.actions),this.manifest.name);let o=await this.wallet.signAndSendTransactions({...e,transactions:n,network:t});if(!o)throw new Error("No result from wallet");return Array.isArray(o.transactions)?o.transactions:o}async signMessage(e){return this.wallet.signMessage({...e,network:e.network??this.connector.network})}async signDelegateActions(e){let t=e.delegateActions.map(n=>({...n,actions:(0,xe.nearActionsToConnectorActions)(n.actions)}));return(0,ve.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(n=>n.actions),this.manifest.name),this.wallet.signDelegateActions({...e,delegateActions:t,network:e.network??this.connector.network})}};z.InjectedWallet=ke});var He=c(B=>{"use strict";Object.defineProperty(B,"__esModule",{value:!0});B.NearWalletsPopup=void 0;var A=D(),Dt=se(),Ft=ce(),Ut={id:"custom-wallet",name:"Custom Wallet",icon:"https://www.mynearwallet.com/images/webclip.png",description:"Custom wallet for NEAR.",website:"",version:"1.0.0",executor:"your-executor-url.js",type:"sandbox",platform:{},features:{signMessage:!0,signInWithoutAddKey:!0,signInAndSignMessage:!0,signAndSendTransaction:!0,signAndSendTransactions:!0,signDelegateActions:!0},permissions:{storage:!0,allowsOpen:[]}},Se=class extends Ft.Popup{delegate;constructor(e){super(e),this.delegate=e,this.update({wallets:e.wallets,showSettings:!1})}handlers(){super.handlers(),this.addListener(".settings-button","click",()=>this.update({showSettings:!0})),this.addListener(".back-button","click",()=>this.update({showSettings:!1})),this.root.querySelectorAll(".connect-item").forEach(e=>{e instanceof HTMLDivElement&&this.addListener(e,"click",()=>this.delegate.onSelect(e.dataset.type))}),this.root.querySelectorAll(".remove-wallet-button").forEach(e=>{e instanceof SVGSVGElement&&this.addListener(e,"click",async t=>{t.stopPropagation(),await this.delegate.onRemoveDebugManifest(e.dataset.type);let n=this.state.wallets.filter(o=>o.id!==e.dataset.type);this.update({wallets:n})})}),this.addListener(".add-debug-manifest-button","click",async()=>{try{let e=this.root.querySelector("#debug-manifest-input")?.value??"",t=await this.delegate.onAddDebugManifest(e);this.update({showSettings:!1,wallets:[t,...this.state.wallets]})}catch(e){alert(`Something went wrong: ${e}`)}})}create(){super.create({show:!0})}walletDom(e){let t=(0,A.html)`
      <svg
        class="remove-wallet-button"
        data-type="${e.id}"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style="margin-right: 4px;"
      >
        <path d="M18 6L6 18" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M6 6L18 18" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `;return(0,A.html)`
      <div class="connect-item" data-type="${e.id}">
        <img style="background: #333" src="${e.icon}" alt="${e.name}" />
        <div class="connect-item-info">
          <span>${e.name}</span>
          <span class="wallet-address">${(0,Dt.parseUrl)(e.website)?.hostname}</span>
        </div>
        ${e.debug?t:""}
      </div>
    `}get footer(){if(!this.delegate.footer)return"";let{icon:e,heading:t,link:n,linkText:o}=this.delegate.footer;return(0,A.html)`
      <div class="footer">
        ${e?(0,A.html)`<img src="${e}" alt="${t}" />`:""}
        <p>${t}</p>
        <a class="get-wallet-link" href="${n}" target="_blank">${o}</a>
      </div>
    `}get dom(){return this.state.showSettings?(0,A.html)`
        <div class="modal-container">
          <div class="modal-content">
            <div class="modal-header">
              <button class="back-button" style="left: 16px; right: unset;">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M15 18L9 12L15 6" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <p>Settings</p>
            </div>

            <div class="modal-body">
              <p style="text-align: left;">
                You can add your wallet to dapp for debug,
                <a href="https://github.com/azbang/hot-connector" target="_blank">read the documentation.</a> Paste your manifest and click "Add".
              </p>

              <textarea style="width: 100%;" id="debug-manifest-input" rows="10">${JSON.stringify(Ut,null,2)}</textarea>
              <button class="add-debug-manifest-button">Add</button>
            </div>

            ${this.footer}
          </div>
        </div>
      `:(0,A.html)`<div class="modal-container">
      <div class="modal-content">
        <div class="modal-header">
          <p>Select wallet</p>
          <button class="settings-button">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
              <circle cx="19" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
              <circle cx="5" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
            </svg>
          </button>
        </div>

        <div class="modal-body">${this.state.wallets.map(e=>this.walletDom(e))}</div>

        ${this.footer}
      </div>
    </div>`}};B.NearWalletsPopup=Se});var ze=c(Ie=>{"use strict";Object.defineProperty(Ie,"__esModule",{value:!0});var Ce=class{dbName;storeName;version;constructor(e,t){this.dbName=e,this.storeName=t,this.version=1}getDb(){return new Promise((e,t)=>{if(typeof window>"u"||typeof indexedDB>"u"){t(new Error("IndexedDB is not available (SSR environment)"));return}let n=indexedDB.open(this.dbName,this.version);n.onerror=o=>{console.error("Error opening database:",o.target.error),t(new Error("Error opening database"))},n.onsuccess=o=>{e(n.result)},n.onupgradeneeded=o=>{let r=n.result;r.objectStoreNames.contains(this.storeName)||r.createObjectStore(this.storeName)}})}async getItem(e){let t=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((n,o)=>{if(!this.storeName){o(new Error("Store name not set"));return}let r=t.transaction(this.storeName,"readonly");r.onerror=l=>o(r.error);let i=r.objectStore(this.storeName).get(e);i.onerror=l=>o(i.error),i.onsuccess=()=>{n(i.result),t.close()}})}async setItem(e,t){let n=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((o,r)=>{if(!this.storeName){r(new Error("Store name not set"));return}let a=n.transaction(this.storeName,"readwrite");a.onerror=d=>r(a.error);let l=a.objectStore(this.storeName).put(t,e);l.onerror=d=>r(l.error),l.onsuccess=()=>{n.close(),o()}})}async removeItem(e){let t=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((n,o)=>{if(!this.storeName){o(new Error("Store name not set"));return}let r=t.transaction(this.storeName,"readwrite");r.onerror=l=>o(r.error);let i=r.objectStore(this.storeName).delete(e);i.onerror=l=>o(i.error),i.onsuccess=()=>{t.close(),n()}})}async keys(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let o=e.transaction(this.storeName,"readonly");o.onerror=i=>n(o.error);let a=o.objectStore(this.storeName).getAllKeys();a.onerror=i=>n(a.error),a.onsuccess=()=>{t(a.result),e.close()}})}async count(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let o=e.transaction(this.storeName,"readonly");o.onerror=i=>n(o.error);let a=o.objectStore(this.storeName).count();a.onerror=i=>n(a.error),a.onsuccess=()=>{t(a.result),e.close()}})}async length(){return this.count()}async clear(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let o=e.transaction(this.storeName,"readwrite");o.onerror=i=>n(o.error);let a=o.objectStore(this.storeName).clear();a.onerror=i=>n(a.error),a.onsuccess=()=>{e.close(),t()}})}};Ie.default=Ce});var Je=c(S=>{"use strict";var Rt=S&&S.__importDefault||function(s){return s&&s.__esModule?s:{default:s}};Object.defineProperty(S,"__esModule",{value:!0});S.NearConnector=void 0;var Gt=ae(),Ht=He(),zt=X(),Bt=Rt(ze()),Jt=ne(),Vt=Ae(),Be=be(),Yt=["https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json","https://cdn.jsdelivr.net/gh/azbang/hot-connector/repository/manifest.json"];function Xt(s){return e=>Object.entries(s).length===0?!0:Object.entries(s).filter(([t,n])=>n===!0).every(([t])=>e.manifest.features?.[t]===!0)}var Pe=class{storage;events;db;logger;wallets=[];manifest={wallets:[],version:"1.0.0"};features={};network="mainnet";providers={mainnet:[],testnet:[]};walletConnect;footerBranding;excludedWallets=[];autoConnect;cspNonce;whenManifestLoaded;constructor(e){this.db=new Bt.default("hot-connector","wallets"),this.storage=e?.storage??new zt.LocalStorage,this.events=e?.events??new Gt.EventEmitter,this.logger=e?.logger,this.cspNonce=e?.cspNonce,this.network=e?.network??"mainnet",this.walletConnect=e?.walletConnect,this.autoConnect=e?.autoConnect??!0,this.providers=e?.providers??{mainnet:[],testnet:[]},this.excludedWallets=e?.excludedWallets??[],this.features=e?.features??{},e?.footerBranding!==void 0?this.footerBranding=e?.footerBranding:this.footerBranding={icon:"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%20512%20512%22%20class%3D%22size-7%22%3E%3Crect%20width%3D%22512%22%20height%3D%22512%22%20fill%3D%22%2300ec97%22%20rx%3D%22110%22%2F%3E%3Cpath%20fill%3D%22%23000%22%20d%3D%22M373.89%20106.199a31.95%2031.95%200%200%200-27.213%2015.207l-62.631%2092.979a6.67%206.67%200%200%200-.989%205.001%206.66%206.66%200%200%200%202.837%204.235%206.67%206.67%200%200%200%208.032-.494l61.643-53.47c1.02-.924%202.599-.827%203.523.193.419.473.644%201.074.644%201.697v167.402a2.49%202.49%200%200%201-2.502%202.491%202.48%202.48%200%200%201-1.912-.891L168.976%20117.497a31.93%2031.93%200%200%200-24.356-11.298h-6.508c-17.623%200-31.917%2014.294-31.917%2031.917v235.767c0%2017.623%2014.294%2031.917%2031.917%2031.917a31.94%2031.94%200%200%200%2027.213-15.206l62.631-92.98a6.66%206.66%200%200%200-1.847-9.236%206.67%206.67%200%200%200-8.033.494l-61.643%2053.471c-1.02.923-2.599.826-3.522-.194a2.5%202.5%200%200%201-.634-1.697V173.008a2.49%202.49%200%200%201%202.502-2.492c.731%200%201.439.322%201.912.891l186.313%20223.096a31.95%2031.95%200%200%200%2024.357%2011.297h6.508c17.623%200%2031.927-14.272%2031.938-31.895V138.116c0-17.623-14.294-31.917-31.917-31.917%22%2F%3E%3C%2Fsvg%3E",heading:"NEAR Connector",link:"https://wallet.near.org",linkText:"Don't have a wallet?"},this.whenManifestLoaded=new Promise(async t=>{e?.manifest==null||typeof e.manifest=="string"?this.manifest=await this._loadManifest(e?.manifest).catch(()=>({wallets:[],version:"1.0.0"})):this.manifest=e?.manifest??{wallets:[],version:"1.0.0"};let n=new Set(this.excludedWallets);n.delete("hot-wallet"),this.manifest.wallets=this.manifest.wallets.filter(o=>!(o.permissions.walletConnect&&!this.walletConnect||n.has(o.id))),await new Promise(o=>setTimeout(o,100)),t()}),typeof window<"u"&&(window.addEventListener("near-wallet-injected",this._handleNearWalletInjected),window.dispatchEvent(new Event("near-selector-ready")),window.addEventListener("message",async t=>{t.data.type==="near-wallet-injected"&&(await this.whenManifestLoaded.catch(()=>{}),this.wallets=this.wallets.filter(n=>n.manifest.id!==t.data.manifest.id),this.wallets.unshift(new Jt.ParentFrameWallet(this,t.data.manifest)),this.events.emit("selector:walletsChanged",{}),this.autoConnect&&this.connect({walletId:t.data.manifest.id}))})),this.whenManifestLoaded.then(()=>{typeof window<"u"&&window.parent.postMessage({type:"near-selector-ready"},"*"),this.manifest.wallets.forEach(t=>this.registerWallet(t)),this.storage.get("debug-wallets").then(t=>{JSON.parse(t??"[]").forEach(o=>this.registerDebugWallet(o))})})}get availableWallets(){return this.wallets.filter(t=>Object.entries(this.features).every(([n,o])=>!(o&&!t.manifest.features?.[n]))).filter(t=>!(this.network==="testnet"&&!t.manifest.features?.testnet))}_handleNearWalletInjected=e=>{this.wallets=this.wallets.filter(t=>t.manifest.id!==e.detail.manifest.id),this.wallets.unshift(new Vt.InjectedWallet(this,e.detail)),this.events.emit("selector:walletsChanged",{})};async _loadManifest(e){let t=e?[e]:Yt;for(let n of t){let o=await fetch(n).catch(()=>null);if(!(!o||!o.ok))return await o.json()}throw new Error("Failed to load manifest")}async switchNetwork(e,t){this.network!==e&&(await this.disconnect().catch(()=>{}),this.network=e,await this.connect(t))}async registerWallet(e){if(e.type!=="sandbox")throw new Error("Only sandbox wallets are supported");this.wallets.find(t=>t.manifest.id===e.id)||(this.wallets.push(new Be.SandboxWallet(this,e)),this.events.emit("selector:walletsChanged",{}))}async registerDebugWallet(e){let t=typeof e=="string"?JSON.parse(e):e;if(t.type!=="sandbox")throw new Error("Only sandbox wallets type are supported");if(!t.id)throw new Error("Manifest must have an id");if(!t.name)throw new Error("Manifest must have a name");if(!t.icon)throw new Error("Manifest must have an icon");if(!t.website)throw new Error("Manifest must have a website");if(!t.version)throw new Error("Manifest must have a version");if(!t.executor)throw new Error("Manifest must have an executor");if(!t.features)throw new Error("Manifest must have features");if(!t.permissions)throw new Error("Manifest must have permissions");if(this.wallets.find(o=>o.manifest.id===t.id))throw new Error("Wallet already registered");t.debug=!0,this.wallets.unshift(new Be.SandboxWallet(this,t)),this.events.emit("selector:walletsChanged",{});let n=this.wallets.filter(o=>o.manifest.debug).map(o=>o.manifest);return this.storage.set("debug-wallets",JSON.stringify(n)),t}async removeDebugWallet(e){this.wallets=this.wallets.filter(n=>n.manifest.id!==e);let t=this.wallets.filter(n=>n.manifest.debug).map(n=>n.manifest);this.storage.set("debug-wallets",JSON.stringify(t)),this.events.emit("selector:walletsChanged",{})}async selectWallet({features:e={}}={}){return await this.whenManifestLoaded.catch(()=>{}),new Promise((t,n)=>{let o=new Ht.NearWalletsPopup({footer:this.footerBranding,wallets:this.availableWallets.filter(Xt(e)).map(r=>r.manifest),onRemoveDebugManifest:async r=>this.removeDebugWallet(r),onAddDebugManifest:async r=>this.registerDebugWallet(r),onReject:()=>(n(new Error("User rejected")),o.destroy()),onSelect:r=>(t(r),o.destroy())});o.create()})}async connect(e={}){let t=e.walletId,n=e.signMessageParams;await this.whenManifestLoaded.catch(()=>{}),t||(t=await this.selectWallet({features:{signInAndSignMessage:e.signMessageParams!=null?!0:void 0,signInWithFunctionCallKey:e.addFunctionCallKey!=null?!0:void 0}}));try{let o=await this.wallet(t);this.logger?.log("Wallet available to connect",o),await this.storage.set("selected-wallet",t),this.logger?.log(`Set preferred wallet, try to signIn${n!=null?" (with signed message)":""}`,t);let r;if(e.addFunctionCallKey!=null&&(this.logger?.log("Adding function call access key during sign in with params",e.addFunctionCallKey),r={...e.addFunctionCallKey,gasAllowance:e.addFunctionCallKey.gasAllowance??{amount:"250000000000000000000000",kind:"limited"}}),n!=null){let a=await o.signInAndSignMessage({addFunctionCallKey:r,messageParams:n,network:this.network});if(!a?.length)throw new Error("Failed to sign in");this.logger?.log("Signed in to wallet (with signed message)",t,a),this.events.emit("wallet:signInAndSignMessage",{wallet:o,accounts:a,success:!0}),this.events.emit("wallet:signIn",{wallet:o,accounts:a.map(i=>({accountId:i.accountId,publicKey:i.publicKey})),success:!0,source:"signInAndSignMessage"})}else{let a=await o.signIn({addFunctionCallKey:r,network:this.network});if(!a?.length)throw new Error("Failed to sign in");this.logger?.log("Signed in to wallet",t,a),this.events.emit("wallet:signIn",{wallet:o,accounts:a,success:!0,source:"signIn"})}return o}catch(o){throw this.logger?.log("Failed to connect to wallet",o),o}}async disconnect(e){e||(e=await this.wallet()),await e.signOut({network:this.network}),await this.storage.remove("selected-wallet"),this.events.emit("wallet:signOut",{success:!0})}async getConnectedWallet(){await this.whenManifestLoaded.catch(()=>{});let e=await this.storage.get("selected-wallet"),t=this.wallets.find(o=>o.manifest.id===e);if(!t)throw new Error("No wallet selected");let n=await t.getAccounts();if(!n?.length)throw new Error("No accounts found");return{wallet:t,accounts:n}}async wallet(e){if(await this.whenManifestLoaded.catch(()=>{}),!e)return this.getConnectedWallet().then(({wallet:n})=>n).catch(async()=>{throw await this.storage.remove("selected-wallet"),new Error("No accounts found")});let t=this.wallets.find(n=>n.manifest.id===e);if(!t)throw new Error("Wallet not found");return t}async use(e){await this.whenManifestLoaded.catch(()=>{}),this.wallets=this.wallets.map(t=>new Proxy(t,{get(n,o,r){let a=Reflect.get(n,o,r);if(o in e&&typeof a=="function"){let i=e[o];return function(...l){let d=()=>a.apply(n,l);return l.length>0?i.call(this,...l,d):i.call(this,void 0,d)}}return a}}))}on(e,t){this.events.on(e,t)}once(e,t){this.events.once(e,t)}off(e,t){this.events.off(e,t)}removeAllListeners(e){this.events.removeAllListeners(e)}};S.NearConnector=Pe});var Ye=c(u=>{"use strict";Object.defineProperty(u,"__esModule",{value:!0});u.assertGasKeyActionsSupported=u.isGasKeyAction=u.nearActionsToConnectorActions=u.NearConnector=u.InjectedWallet=u.SandboxWallet=u.ParentFrameWallet=u.LocalStorage=void 0;var Zt=X();Object.defineProperty(u,"LocalStorage",{enumerable:!0,get:function(){return Zt.LocalStorage}});var Qt=ne();Object.defineProperty(u,"ParentFrameWallet",{enumerable:!0,get:function(){return Qt.ParentFrameWallet}});var en=be();Object.defineProperty(u,"SandboxWallet",{enumerable:!0,get:function(){return en.SandboxWallet}});var tn=Ae();Object.defineProperty(u,"InjectedWallet",{enumerable:!0,get:function(){return tn.InjectedWallet}});var nn=Je();Object.defineProperty(u,"NearConnector",{enumerable:!0,get:function(){return nn.NearConnector}});var sn=C();Object.defineProperty(u,"nearActionsToConnectorActions",{enumerable:!0,get:function(){return sn.nearActionsToConnectorActions}});var Ve=I();Object.defineProperty(u,"isGasKeyAction",{enumerable:!0,get:function(){return Ve.isGasKeyAction}});Object.defineProperty(u,"assertGasKeyActionsSupported",{enumerable:!0,get:function(){return Ve.assertGasKeyActionsSupported}})});var Xe=rt(Ye(),1),on=document.querySelector("#near-payment"),h=JSON.parse(on.dataset.payment),_e=document.querySelector("#near-pay"),E=document.querySelector("#near-status"),M=document.querySelector("#near-error"),b=document.querySelector("#near-confirm"),Ee=`nanoodle-near:${h.paymentId}`,g=h,x=!1,w=null;try{w=JSON.parse(localStorage.getItem(Ee))}catch{}var J=s=>{w=s;try{s?localStorage.setItem(Ee,JSON.stringify(s)):localStorage.removeItem(Ee)}catch{}};function f(s){g=s;let e=h.asset==="USDC"?"USDC":"NEAR",t={pending:"Ready to pay. Approve the deposit in your NEAR wallet.",paid:"Payment confirmed. Your agent is continuing \u2014 no further payment needed.",running:"Payment confirmed. Your workflow is running.",settled:`Complete. Unused ${e} is returned to the wallet that paid.`,failed:"The run failed. Your deposit is being refunded to the wallet that paid.",rejected:`This payment could not buy the run. Received ${e} is being refunded.`,expired:"This quote expired. Ask your agent for a fresh quote.",unknown:"Unknown payment. Ask your agent for a fresh quote."};E.textContent=t[s.status]||s.status,s.receipt?.refund?.status==="pending"&&(E.textContent+=" The refund is pending; it will retry automatically."),s.receipt?.refund?.status==="failed_permanent"&&(E.textContent+=` Contact the operator with payment id ${h.paymentId} about the refund.`),_e.disabled=x||s.status!=="pending"||!!w,_e.textContent=w?"Payment submitted \u2014 confirm below if needed":"Connect wallet & pay",w&&s.status==="pending"&&(E.textContent="A wallet payment was already requested. Confirm that transfer below; do not send it twice.")}async function Me(s,e){M.textContent="";for(let t=0;t<10;t++){E.textContent="Confirming your transfer on NEAR\u2026";let n=await fetch(`/near/pay/${encodeURIComponent(h.paymentId)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({txHash:s,senderId:e})}),o=await n.json();if(o.status&&f(o),n.ok)return;if(o.error&&/not found as final|not final|could not be reached/.test(o.error)&&t<9){await new Promise(r=>setTimeout(r,3e3));continue}throw new Error(o.error||"Confirmation failed. Retry confirming the same transfer below.")}}_e.addEventListener("click",async()=>{if(!(x||w||g.status!=="pending")){x=!0,M.textContent="",f(g);try{let s=await fetch(`/near/status/${encodeURIComponent(h.paymentId)}`,{cache:"no-store"});if(f(await s.json()),!s.ok||g.status!=="pending")return;let t=await new Xe.NearConnector({network:h.network,features:{signAndSendTransaction:!0,signInWithoutAddKey:!0}}).connect(),o=(await t.getAccounts({network:h.network}))[0]?.accountId;if(!o)throw new Error("The wallet did not return a NEAR account.");J({senderId:o});let a=(await t.signAndSendTransaction({network:h.network,signerId:o,receiverId:h.asset==="USDC"?h.tokenContract:h.payTo,actions:h.asset==="USDC"?[{type:"FunctionCall",params:{methodName:"ft_transfer",args:{receiver_id:h.payTo,amount:h.amountAtomic},gas:"30000000000000",deposit:"1"}}]:[{type:"Transfer",params:{deposit:h.amountYocto}}]}))?.transaction?.hash;if(!a)throw new Error("Check your wallet history and confirm the transaction below. Do not send the deposit again.");J({senderId:o,txHash:a}),b.elements.senderId.value=o,b.elements.txHash.value=a,await Me(a,o)}catch(s){/reject|cancel|denied/i.test(s.message)&&!w?.txHash&&J(null),M.textContent=s.message}finally{x=!1,f(g)}}});b.addEventListener("submit",async s=>{if(s.preventDefault(),x)return;x=!0;let e=b.elements.senderId.value.trim(),t=b.elements.txHash.value.trim();J({senderId:e,txHash:t}),f(g);try{await Me(t,e)}catch(n){M.textContent=n.message}finally{x=!1,f(g)}});f(g);w?.senderId&&(b.elements.senderId.value=w.senderId);w?.txHash&&(b.elements.txHash.value=w.txHash,g.status==="pending"&&Me(w.txHash,w.senderId).catch(s=>{M.textContent=s.message}));var V=new EventSource(`/near/watch/${encodeURIComponent(h.paymentId)}`);V.addEventListener("status",s=>{let e=JSON.parse(s.data);f(e),e.done&&V.close()});V.onerror=async()=>{for(V.close();g.status==="pending";)try{let s=await fetch(`/near/status/${encodeURIComponent(h.paymentId)}?wait=1`,{cache:"no-store"});f(await s.json())}catch{await new Promise(s=>setTimeout(s,3e3))}};
