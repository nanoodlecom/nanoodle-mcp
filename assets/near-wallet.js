/*! Nanoodle browser assets. Wallet dependency licenses: /near-wallet.LICENSE.txt */
var yt=Object.create;var ze=Object.defineProperty;var bt=Object.getOwnPropertyDescriptor;var xt=Object.getOwnPropertyNames;var kt=Object.getPrototypeOf,vt=Object.prototype.hasOwnProperty;var h=(o,e)=>()=>{try{return e||o((e={exports:{}}).exports,e),e.exports}catch(t){throw e=0,t}};var St=(o,e,t,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of xt(e))!vt.call(o,r)&&r!==t&&ze(o,r,{get:()=>e[r],enumerable:!(n=bt(e,r))||n.enumerable});return o};var At=(o,e,t)=>(t=o!=null?yt(kt(o)):{},St(e||!o||!o.__esModule?ze(t,"default",{value:o,enumerable:!0}):t,o));var ie=h(R=>{"use strict";Object.defineProperty(R,"__esModule",{value:!0});R.LocalStorage=void 0;var ae=class{async get(e){return typeof window>"u"?null:localStorage.getItem(e)}async set(e,t){typeof window>"u"||localStorage.setItem(e,t)}async remove(e){typeof window>"u"||localStorage.removeItem(e)}};R.LocalStorage=ae});var Be=h(le=>{"use strict";Object.defineProperty(le,"__esModule",{value:!0});le.encodeBase58=Ct;var Ge="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";function Ct(o){if(o.length===0)return"";let e=0,t=0;for(;t<o.length&&o[t]===0;)e++,t++;let n=[0];for(;t<o.length;t++){let s=o[t];for(let a=0;a<n.length;++a)s+=n[a]<<8,n[a]=s%58,s=s/58|0;for(;s>0;)n.push(s%58),s=s/58|0}for(;n.length>0&&n[n.length-1]===0;)n.pop();let r="";for(let s=0;s<e;s++)r+=Ge[0];for(let s=n.length-1;s>=0;--s)r+=Ge[n[s]];return r}});var O=h(U=>{"use strict";Object.defineProperty(U,"__esModule",{value:!0});U.nearActionsToConnectorActions=void 0;var $t=Be(),Pt=o=>{try{return JSON.parse(new TextDecoder().decode(o))}catch{return o}},_t=o=>o.enum!=null?o.enum==="fullAccess":"fullAccess"in o,It=o=>o.enum!=null?o.enum==="AccountId":"AccountId"in o,Et=o=>o.map(e=>{if("type"in e)return e;if(e.signedDelegate)throw new Error("SignedDelegate actions cannot be sent through the wallet connector; wallets sign delegates via signDelegateActions");if(e.functionCall)return{type:"FunctionCall",params:{methodName:e.functionCall.methodName,args:Pt(e.functionCall.args),gas:e.functionCall.gas.toString(),deposit:e.functionCall.deposit.toString()}};if(e.deployGlobalContract)return{type:"DeployGlobalContract",params:{code:e.deployGlobalContract.code,deployMode:It(e.deployGlobalContract.deployMode)?"AccountId":"CodeHash"}};if(e.createAccount)return{type:"CreateAccount"};if(e.useGlobalContract){let t=e.useGlobalContract.contractIdentifier;return{type:"UseGlobalContract",params:{contractIdentifier:t.AccountId!=null?{accountId:t.AccountId}:{codeHash:(0,$t.encodeBase58)(t.CodeHash)}}}}if(e.deployContract)return{type:"DeployContract",params:{code:e.deployContract.code}};if(e.deleteAccount)return{type:"DeleteAccount",params:{beneficiaryId:e.deleteAccount.beneficiaryId}};if(e.deleteKey)return{type:"DeleteKey",params:{publicKey:e.deleteKey.publicKey.toString()}};if(e.transfer)return{type:"Transfer",params:{deposit:e.transfer.deposit.toString()}};if(e.stake)return{type:"Stake",params:{stake:e.stake.stake.toString(),publicKey:e.stake.publicKey.toString()}};if(e.addKey){let{permission:t}=e.addKey.accessKey,n;if(t.functionCall)n={receiverId:t.functionCall.receiverId,allowance:t.functionCall.allowance?.toString(),methodNames:t.functionCall.methodNames};else if(_t(t))n="FullAccess";else throw new Error("Unsupported access-key permission on AddKey: only functionCall and fullAccess can be sent through the wallet connector (pass a ConnectorAction otherwise)");return{type:"AddKey",params:{publicKey:e.addKey.publicKey.toString(),accessKey:{nonce:Number(e.addKey.accessKey.nonce),permission:n}}}}throw new Error("Unsupported action type")});U.nearActionsToConnectorActions=Et});var q=h(N=>{"use strict";Object.defineProperty(N,"__esModule",{value:!0});N.isGasKeyAction=void 0;N.assertGasKeyActionsSupported=Nt;var Mt=o=>o.type==="TransferToGasKey"||o.type==="WithdrawFromGasKey"||o.type==="AddKey"&&o.params.gasKeyInfo!=null;N.isGasKeyAction=Mt;function Nt(o,e,t){if(o?.gasKeys)return;let n=e.filter(N.isGasKeyAction).map(r=>r.type);if(n.length!==0)throw new Error(`${t} does not advertise gas-key support (manifest features.gasKeys), so ${[...new Set(n)].join(", ")} cannot be sent through it; a wallet that does not know gasKeyInfo could add a plain key instead. Sign locally with a full-access key, or use a wallet whose manifest sets features.gasKeys.`)}});var G=h(z=>{"use strict";Object.defineProperty(z,"__esModule",{value:!0});z.uuid4=void 0;var jt=()=>typeof window<"u"&&typeof window.crypto<"u"&&typeof window.crypto.randomUUID=="function"?window.crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(o){let e=Math.random()*16|0;return(o==="x"?e:e&3|8).toString(16)});z.uuid4=jt});var he=h(B=>{"use strict";Object.defineProperty(B,"__esModule",{value:!0});B.ParentFrameWallet=void 0;var ce=O(),de=q(),Wt=G(),ue=class{connector;manifest;constructor(e,t){this.connector=e,this.manifest=t}callParentFrame(e,t){let n=(0,Wt.uuid4)();return window.parent.postMessage({type:"near-wallet-injected-request",id:n,method:e,params:t},"*"),new Promise((r,s)=>{let a=i=>{i.data.type==="near-wallet-injected-response"&&i.data.id===n&&(window.removeEventListener("message",a),i.data.success?r(i.data.result):s(i.data.error))};window.addEventListener("message",a)})}async signIn(e){let t=await this.callParentFrame("near:signIn",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey});return Array.isArray(t)?t:[t]}async signInAndSignMessage(e){let t=await this.callParentFrame("near:signInAndSignMessage",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey,messageParams:e.messageParams});return Array.isArray(t)?t:[t]}async signOut(e){let t={...e,network:e?.network??this.connector.network};await this.callParentFrame("near:signOut",t)}async getAccounts(e){let t={...e,network:e?.network??this.connector.network};return this.callParentFrame("near:getAccounts",t)}async signAndSendTransaction(e){let t=(0,ce.nearActionsToConnectorActions)(e.actions);(0,de.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n={...e,actions:t,network:e.network??this.connector.network};return this.callParentFrame("near:signAndSendTransaction",n)}async signAndSendTransactions(e){let t=e.transactions.map(r=>({actions:(0,ce.nearActionsToConnectorActions)(r.actions),receiverId:r.receiverId}));(0,de.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(r=>r.actions),this.manifest.name);let n={...e,transactions:t,network:e.network??this.connector.network};return this.callParentFrame("near:signAndSendTransactions",n)}async signMessage(e){let t={...e,network:e.network??this.connector.network};return this.callParentFrame("near:signMessage",t)}async signDelegateActions(e){let t={...e,delegateActions:e.delegateActions.map(n=>({...n,actions:(0,ce.nearActionsToConnectorActions)(n.actions)})),network:e.network||this.connector.network};return(0,de.assertGasKeyActionsSupported)(this.manifest.features,t.delegateActions.flatMap(n=>n.actions),this.manifest.name),this.callParentFrame("near:signDelegateActions",t)}};B.ParentFrameWallet=ue});var fe=h(H=>{"use strict";Object.defineProperty(H,"__esModule",{value:!0});H.parseUrl=void 0;var Tt=o=>{try{return new URL(o)}catch{return null}};H.parseUrl=Tt});var He=h(J=>{"use strict";Object.defineProperty(J,"__esModule",{value:!0});J.copyText=void 0;var Ot=async o=>{try{await navigator.clipboard.writeText(o);return}catch{}let e=document.createElement("textarea");e.value=o,e.setAttribute("readonly",""),e.style.position="fixed",e.style.opacity="0",document.body.appendChild(e),e.select();try{if(!document.execCommand("copy"))throw new Error("Copy failed")}finally{e.remove()}};J.copyText=Ot});var Ye=h(v=>{"use strict";Object.defineProperty(v,"__esModule",{value:!0});v.openExternalLink=v.openTelegramLink=v.isTelegramMiniApp=void 0;var pe=()=>{let o=window?.Telegram?.WebApp;return!o||!o.platform||o.platform==="unknown"?null:o},qt=()=>{try{return location.hash.includes("tgWebAppData")?!0:!!sessionStorage.getItem("__telegram__initParams")}catch{return!1}},Lt=()=>typeof window>"u"?!1:!!pe()||!!window.TelegramWebviewProxy||qt();v.isTelegramMiniApp=Lt;var Je=(o,e)=>{let t=window.TelegramWebviewProxy;if(t?.postEvent)return t.postEvent(o,JSON.stringify(e));let n=window.external;if(n&&"notify"in n)return n.notify(JSON.stringify({eventType:o,eventData:e}));window.parent!==window&&window.parent.postMessage(JSON.stringify({eventType:o,eventData:e}),"https://web.telegram.org")},Kt=o=>{let e=pe();if(e)return e.openTelegramLink(o.toString());Je("web_app_open_tg_link",{path_full:o.pathname+o.search})};v.openTelegramLink=Kt;var Dt=o=>{let e=pe();if(e)return e.openLink(o.toString());Je("web_app_open_link",{url:o.toString()})};v.openExternalLink=Dt});var ge=h(Y=>{"use strict";Object.defineProperty(Y,"__esModule",{value:!0});Y.EventEmitter=void 0;var we=class{events={};on(e,t){this.events[e]||(this.events[e]=[]),this.events[e].push(t)}emit(e,t){this.events[e]?.forEach(n=>n(t))}off(e,t){this.events[e]=this.events[e]?.filter(n=>n!==t)}once(e,t){let n=r=>{t(r),this.off(e,n)};this.on(e,n)}removeAllListeners(e){e?delete this.events[e]:this.events={}}};Y.EventEmitter=we});var X=h(V=>{"use strict";Object.defineProperty(V,"__esModule",{value:!0});V.escapeHtml=Ve;V.html=Ft;function Ve(o){return o.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}var me=Symbol("htmlTag");function Ft(o,...e){let t=o[0];for(let n=0;n<e.length;n++){for(let r of Array.isArray(e[n])?e[n]:[e[n]]){let s=r?.[me]?r[me]:Ve(String(r??""));t+=s}t+=o[n+1]}return Object.freeze({[me]:t,get html(){return t}})}});var Xe=h(Q=>{"use strict";Object.defineProperty(Q,"__esModule",{value:!0});Q.css=void 0;var Rt=o=>`
${o} * {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
  -ms-overflow-style: none; 
  scrollbar-width: none; 
  color: #fff;
}

${o} *::-webkit-scrollbar { 
  display: none;
}

${o} p,
${o} h1,
${o} h2,
${o} h3,
${o} h4,
${o} h5,
${o} h6 {
  margin: 0;
}

${o} .modal-container {
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
  ${o} .modal-container {
    justify-content: flex-end;
  }
}

${o} .modal-content {
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
  ${o} .modal-content {
    max-width: 100%;
    width: 100%;
    max-height: 80%;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border: none;
    border-top: 1.5px solid rgba(255, 255, 255, 0.1);
  }
}


${o} .modal-header {
  display: flex;
  padding: 16px;
  gap: 16px;
  align-self: stretch;
  align-items: center;
  justify-content: center;
  position: relative;
}

${o} .modal-header button {
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

${o} .modal-header button:hover {
  background: rgba(255, 255, 255, 0.04);
}
  
${o} .modal-header p {
  color: #fff;
  text-align: center;
  font-size: 24px;
  font-style: normal;
  font-weight: 600;
  line-height: normal;
  margin: 0;
}


${o} .modal-body {
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

${o} .modal-body textarea {
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

${o} .modal-body button {
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

${o} .footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 16px 24px;
  color: #fff;
  gap: 12px;
}

${o} .modal-body p {
  color: rgba(255, 255, 255, 0.9);
  text-align: center;
  font-size: 16px;
  font-style: normal;
  font-weight: 500;
  line-height: normal;
  letter-spacing: -0.8px;
}

${o} .footer img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

${o} .get-wallet-link {
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
  
${o} .get-wallet-link:hover {
  color: rgba(255, 255, 255, 1);
}


${o} .connect-item {
  display: flex;
  padding: 8px;
  align-items: center;
  gap: 12px;
  align-self: stretch;
  cursor: pointer;

  transition: background 0.2s ease-in-out;
  border-radius: 24px;
}

${o} .connect-item img {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  object-fit: cover;
  flex-shrink: 0;
}

${o} .connect-item-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  text-align: left;
  flex: 1;
  margin-top: -2px;
}

${o} .connect-item-info .wallet-address {
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
  font-style: normal;
  font-weight: 400;
  line-height: normal;
}

${o} .connect-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

${o} .connect-item img {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  object-fit: cover;
}

${o} .connect-item p {
  color: rgba(255, 255, 255, 0.9);
  text-align: center;
  font-size: 18px;
  font-style: normal;
  font-weight: 600;
  line-height: normal;
  letter-spacing: -0.36px;
  margin: 0;
}
`;Q.css=Rt});var be=h(Z=>{"use strict";Object.defineProperty(Z,"__esModule",{value:!0});Z.Popup=void 0;var Ut=Xe(),zt=X(),Qe=`n${Math.random().toString(36).substring(2,15)}`;if(typeof document<"u"){let o=document.createElement("style");o.textContent=(0,Ut.css)(`.${Qe}`),document.head.append(o)}var ye=class{delegate;isClosed=!1;root=document.createElement("div");state={};constructor(e){this.delegate=e}get dom(){return(0,zt.html)``}disposables=[];addListener(e,t,n){let r=typeof e=="string"?this.root.querySelector(e):e;r&&(r.addEventListener(t,n),this.disposables.push(()=>r.removeEventListener(t,n)))}handlers(){this.disposables.forEach(r=>r()),this.disposables=[];let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.onclick=r=>r.stopPropagation(),e.onclick=()=>{this.delegate.onReject(),this.destroy()};let n=r=>{r.key==="Escape"&&(this.delegate.onReject(),this.destroy())};document.addEventListener("keydown",n),this.disposables.push(()=>document.removeEventListener("keydown",n))}update(e){this.state={...this.state,...e},this.root.innerHTML=this.dom.html,this.handlers()}create({show:e=!0}){this.root.className=`${Qe} hot-connector-popup`,this.root.style.display="none",this.root.innerHTML=this.dom.html,document.body.append(this.root),this.handlers();let t=this.root.querySelector(".modal-container"),n=this.root.querySelector(".modal-content");n.style.transform="translateY(50px)",t.style.opacity="0",e&&setTimeout(()=>this.show(),10)}show(){let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.style.transform="translateY(50px)",e.style.opacity="0",this.root.style.display="block",setTimeout(()=>{t.style.transform="translateY(0)",e.style.opacity="1"},100)}hide(){let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.style.transform="translateY(50px)",e.style.opacity="0",setTimeout(()=>{this.root.style.display="none"},200)}destroy(){this.isClosed||(this.isClosed=!0,this.disposables.forEach(e=>e()),this.disposables=[],this.hide(),setTimeout(()=>{this.root.remove()},200))}};Z.Popup=ye});var Ze=h(ee=>{"use strict";Object.defineProperty(ee,"__esModule",{value:!0});ee.IframeWalletPopup=void 0;var xe=X(),Gt=be(),ke=class extends Gt.Popup{delegate;constructor(e){super(e),this.delegate=e}handlers(){super.handlers(),this.addListener("button","click",()=>this.delegate.onApprove())}create(){super.create({show:!1}),this.root.querySelector(".modal-body").appendChild(this.delegate.iframe),this.delegate.iframe.style.width="100%",this.delegate.iframe.style.height="720px",this.delegate.iframe.style.border="none"}get footer(){if(!this.delegate.footer)return"";let{icon:e,heading:t}=this.delegate.footer;return(0,xe.html)`
      <div class="footer">
        ${e?(0,xe.html)`<img src="${e}" alt="${t}" />`:""}
        <p>${t}</p>
      </div>
    `}get dom(){return(0,xe.html)`<div class="modal-container">
      <div class="modal-content">
        <div class="modal-body" style="padding: 0; overflow: auto;"></div>
        ${this.footer}
      </div>
    </div>`}};ee.IframeWalletPopup=ke});var et=h(te=>{"use strict";Object.defineProperty(te,"__esModule",{value:!0});te.NEAR_CONNECT_VERSION=void 0;te.NEAR_CONNECT_VERSION="0.12.0"});var tt=h(ve=>{"use strict";Object.defineProperty(ve,"__esModule",{value:!0});var Bt=et();async function Ht(o){let e=await o.executor.getAllStorage(),t=o.executor.connector.providers,n=o.executor.manifest,r=o.id,s=o.code.replaceAll(".localStorage",".sandboxedLocalStorage").replaceAll("window.top","window.selector").replaceAll("window.open","window.selector.open"),a=o.cspNonce?` nonce="${o.cspNonce.replace(/[^A-Za-z0-9+/=]/g,"")}"`:"";return`
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
            if (event.data.origin !== "${r}") return;
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
        nearConnectVersion: "${Bt.NEAR_CONNECT_VERSION}",
        
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
          window.parent.postMessage({ method: "wallet-ready", origin: "${r}" }, "*");
          window.selector.wallet = wallet;
        },

        async call(method, params) {
          const id = window.selector.uuid();
          window.parent.postMessage({ method, params, id, origin: "${r}" }, "*");

          return new Promise((resolve, reject) => {
            const handler = (event) => {
              if (event.data.id !== id || event.data.origin !== "${r}") return;
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
            origin: "${r}", 
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
        if (event.data.origin !== "${r}") return;
        if (!event.data.method?.startsWith("wallet:")) return;
      
        const wallet = window.selector.wallet;
        const method = event.data.method.replace("wallet:", "");
        const payload = { id: event.data.id, origin: "${r}", method };
      
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

      <script type="module"${a}>${s}<\/script>
    </body>
  </html>
    `}ve.default=Ht});var nt=h(L=>{"use strict";var Jt=L&&L.__importDefault||function(o){return o&&o.__esModule?o:{default:o}};Object.defineProperty(L,"__esModule",{value:!0});var Yt=ge(),Vt=G(),Xt=Ze(),Qt=Jt(tt()),Se=class{executor;origin;disposed=!1;iframe=document.createElement("iframe");events=new Yt.EventEmitter;popup;handler;readyPromiseResolve;readyPromise=new Promise(e=>{this.readyPromiseResolve=e});constructor(e,t,n,r){this.executor=e,this.origin=(0,Vt.uuid4)(),this.handler=a=>{a.data.origin===this.origin&&(a.data.method==="wallet-ready"&&this.readyPromiseResolve(),n(this,a))},window.addEventListener("message",this.handler);let s=[];this.executor.checkPermissions("usb")&&s.push("usb *;"),this.executor.checkPermissions("hid")&&s.push("hid *;"),this.executor.checkPermissions("clipboardRead")&&s.push("clipboard-read;"),this.executor.checkPermissions("clipboardWrite")&&s.push("clipboard-write;"),this.executor.checkPermissions("bluetooth")&&s.push("bluetooth *;"),this.iframe.allow=s.join(" "),this.iframe.setAttribute("sandbox","allow-scripts"),(0,Qt.default)({id:this.origin,executor:this.executor,code:t,cspNonce:r}).then(a=>{this.executor.connector.logger?.log("Iframe code injected"),this.iframe.srcdoc=a}),this.popup=new Xt.IframeWalletPopup({footer:this.executor.connector.footerBranding,iframe:this.iframe,onApprove:()=>{},onReject:()=>{this.disposed=!0,window.removeEventListener("message",this.handler),this.events.emit("close",{}),this.popup.destroy()}}),this.popup.create()}on(e,t){this.events.on(e,t)}show(){this.popup.show()}hide(){this.popup.hide()}postMessage(e){if(this.disposed)return;let t=this.iframe.contentWindow;if(!t)throw new Error(`Iframe not loaded for ${e?.method??"unknown method"}`);t.postMessage({...e,origin:this.origin},"*")}dispose(){this.disposed=!0,window.removeEventListener("message",this.handler),this.popup.destroy()}};L.default=Se});var ot=h(K=>{"use strict";var Zt=K&&K.__importDefault||function(o){return o&&o.__esModule?o:{default:o}};Object.defineProperty(K,"__esModule",{value:!0});var C=fe(),Ce=G(),en=He(),Ae=Ye(),tn=Zt(nt()),nn=(0,Ce.uuid4)(),$e=class{connector;manifest;activePanels={};storageSpace;constructor(e,t){this.connector=e,this.manifest=t,this.storageSpace=t.id}checkPermissions(e,t){if(e==="walletConnect")return!!this.manifest.permissions.walletConnect;if(e==="external"){let n=this.manifest.permissions.external;return!n||!t?.entity?!1:n.includes(t.entity)}if(e==="allowsOpen"){let n=(0,C.parseUrl)(t?.url||""),r=this.manifest.permissions.allowsOpen;return!n||!r||!Array.isArray(r)||r.length===0?!1:r.some(a=>{let i=(0,C.parseUrl)(a);return!(!i||n.protocol!==i.protocol||i.hostname&&n.hostname!==i.hostname||i.pathname&&i.pathname!=="/"&&n.pathname!==i.pathname)})}return this.manifest.permissions[e]}assertPermissions(e,t,n){if(!this.checkPermissions(t,n.data.params))throw e.postMessage({...n.data,status:"failed",result:"Permission denied"}),new Error("Permission denied")}_onMessage=async(e,t)=>{let n=s=>{e.postMessage({...t.data,status:"success",result:s})},r=s=>{e.postMessage({...t.data,status:"failed",result:s})};if(t.data.method==="ui.showIframe"){e.show(),n(null);return}if(t.data.method==="ui.hideIframe"){e.hide(),n(null);return}if(t.data.method==="storage.set"){this.assertPermissions(e,"storage",t),localStorage.setItem(`${this.storageSpace}:${t.data.params.key}`,t.data.params.value),n(null);return}if(t.data.method==="storage.get"){this.assertPermissions(e,"storage",t);let s=localStorage.getItem(`${this.storageSpace}:${t.data.params.key}`);n(s);return}if(t.data.method==="storage.keys"){this.assertPermissions(e,"storage",t);let s=Object.keys(localStorage).filter(a=>a.startsWith(`${this.storageSpace}:`));n(s);return}if(t.data.method==="storage.remove"){this.assertPermissions(e,"storage",t),localStorage.removeItem(`${this.storageSpace}:${t.data.params.key}`),n(null);return}if(t.data.method==="panel.focus"){let s=this.activePanels[t.data.params.windowId];s&&s.focus(),n(null);return}if(t.data.method==="panel.postMessage"){let s=this.activePanels[t.data.params.windowId];s&&s.postMessage(t.data.params.data,"*"),n(null);return}if(t.data.method==="panel.close"){let s=this.activePanels[t.data.params.windowId];s&&s.close(),delete this.activePanels[t.data.params.windowId],n(null);return}if(t.data.method==="walletConnect.connect"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).connect(t.data.params);a.approval(),n({uri:a.uri})}catch(s){r(s)}return}if(t.data.method==="walletConnect.getProjectId"){if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");this.assertPermissions(e,"walletConnect",t);let s=await this.connector.walletConnect;n(s.core.projectId);return}if(t.data.method==="walletConnect.disconnect"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).disconnect(t.data.params);n(a)}catch(s){r(s)}return}if(t.data.method==="walletConnect.getSession"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let s=await this.connector.walletConnect,a=s.session.keys[s.session.keys.length-1],i=a?s.session.get(a):null;n(i?{topic:i.topic,namespaces:i.namespaces}:null)}catch(s){r(s)}return}if(t.data.method==="walletConnect.request"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).request(t.data.params);n(a)}catch(s){r(s)}return}if(t.data.method==="clipboard.writeText"){this.assertPermissions(e,"clipboardWrite",t);try{await(0,en.copyText)(t.data.params.text),n(null)}catch(s){r(s)}return}if(t.data.method==="external"){this.assertPermissions(e,"external",t);try{let{entity:s,key:a,args:i}=t.data.params,c=s.split(".").reduce((f,u)=>f[u],window);s==="nightly.near"&&a==="signTransaction"&&(i[0].encode=()=>i[0]);let l=typeof c[a]=="function"?await c[a](...i||[]):c[a];n(l)}catch(s){r(s)}return}if(t.data.method==="open"){this.assertPermissions(e,"allowsOpen",t);let s=(0,C.parseUrl)(t.data.params.url);if(s&&s.protocol==="https:"&&(0,Ae.isTelegramMiniApp)()){s.hostname==="t.me"?(0,Ae.openTelegramLink)(s):(0,Ae.openExternalLink)(s),n(null);return}let a=window.open(t.data.params.url,"_blank",t.data.params.features),i=a?(0,Ce.uuid4)():null,c=l=>{let f=(0,C.parseUrl)(t.data.params.url);f&&f.origin===l.origin&&e.postMessage(l.data)};if(n(i),window.addEventListener("message",c),a&&i){this.activePanels[i]=a;let l=setInterval(()=>{if(!a?.closed)return;window.removeEventListener("message",c);let f={method:"proxy-window:closed",windowId:i};delete this.activePanels[i],clearInterval(l);try{e.postMessage(f)}catch{}},500)}return}if(t.data.method==="open.nativeApp"){this.assertPermissions(e,"allowsOpen",t);let s=(0,C.parseUrl)(t.data.params.url);if(!s||["https","http","javascript:","file:","data:","blob:","about:"].includes(s.protocol))throw r("Invalid URL"),new Error("[open.nativeApp] Invalid URL");let i=document.createElement("iframe");i.src=t.data.params.url,i.style.display="none",document.body.appendChild(i),e.postMessage({...t.data,status:"success",result:null});return}};actualCode=null;async checkNewVersion(e,t){if(this.actualCode)return this.connector.logger?.log("New version of code already checked"),this.actualCode;let n=(0,C.parseUrl)(e.manifest.executor);if(n||(n=(0,C.parseUrl)(location.origin+e.manifest.executor)),!n)throw new Error("Invalid executor URL");n.searchParams.set("nonce",nn);let r=await fetch(n.toString()).then(s=>{if(!s.ok)throw new Error(`Failed to load executor: ${s.status}`);return s.text()});return this.connector.logger?.log("New version of code fetched"),this.actualCode=r,r===t?(this.connector.logger?.log("New version of code is the same as the current version"),this.actualCode):(await this.connector.db.setItem(`${this.manifest.id}:${this.manifest.version}`,r).then(()=>this.connector.logger?.log("New version of code saved to cache")).catch(s=>this.connector.logger?.log("Failed to cache new version of code",s)),r)}async loadCode(){let e=await this.connector.db.getItem(`${this.manifest.id}:${this.manifest.version}`).catch(()=>null);this.connector.logger?.log("Code loaded from cache",e!==null);let t=this.checkNewVersion(this,e);return e||await t}async call(e,t){this.connector.logger?.log("Add to queue",e,t),this.connector.logger?.log("Calling method",e,t);let n=await this.loadCode();this.connector.logger?.log("Code loaded, preparing");let r=new tn.default(this,n,this._onMessage,this.connector.cspNonce);this.connector.logger?.log("Code loaded, iframe initialized"),await r.readyPromise,this.connector.logger?.log("Iframe ready");let s=(0,Ce.uuid4)();return new Promise((a,i)=>{try{let c=l=>{l.data.id!==s||l.data.origin!==r.origin||(r.dispose(),window.removeEventListener("message",c),this.connector.logger?.log("postMessage",{result:l.data,request:{method:e,params:t}}),l.data.status==="failed"?i(l.data.result):a(l.data.result))};window.addEventListener("message",c),r.postMessage({method:e,params:t,id:s}),r.on("close",()=>i(new Error("Wallet closed")))}catch(c){this.connector.logger?.log("Iframe error",c),i(c)}})}async getAllStorage(){let e=Object.keys(localStorage).filter(n=>n.startsWith(`${this.storageSpace}:`)),t={};for(let n of e)t[n.replace(`${this.storageSpace}:`,"")]=localStorage.getItem(n);return t}async clearStorage(){let e=Object.keys(localStorage).filter(t=>t.startsWith(`${this.storageSpace}:`));for(let t of e)localStorage.removeItem(t)}};K.default=$e});var Ie=h($=>{"use strict";var on=$&&$.__importDefault||function(o){return o&&o.__esModule?o:{default:o}};Object.defineProperty($,"__esModule",{value:!0});$.SandboxWallet=void 0;var Pe=O(),_e=q(),rn=on(ot()),ne=class{connector;manifest;executor;constructor(e,t){this.connector=e,this.manifest=t,this.executor=new rn.default(e,t)}async signIn(e){return this.executor.call("wallet:signIn",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey})}async signInAndSignMessage(e){return this.executor.call("wallet:signInAndSignMessage",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey,messageParams:e.messageParams})}async signOut(e){let t={...e,network:e?.network??this.connector.network};await this.executor.call("wallet:signOut",t),await this.executor.clearStorage()}async getAccounts(e){let t={...e,network:e?.network??this.connector.network};return this.executor.call("wallet:getAccounts",t)}async signAndSendTransaction(e){let t=(0,Pe.nearActionsToConnectorActions)(e.actions);(0,_e.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n={...e,actions:t,network:e.network??this.connector.network};return this.executor.call("wallet:signAndSendTransaction",n)}async signAndSendTransactions(e){let t=e.transactions.map(r=>({actions:(0,Pe.nearActionsToConnectorActions)(r.actions),receiverId:r.receiverId}));(0,_e.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(r=>r.actions),this.manifest.name);let n={...e,transactions:t,network:e.network??this.connector.network};return this.executor.call("wallet:signAndSendTransactions",n)}async signMessage(e){let t={...e,network:e.network??this.connector.network};return this.executor.call("wallet:signMessage",t)}async signDelegateActions(e){let t={...e,delegateActions:e.delegateActions.map(n=>({...n,actions:(0,Pe.nearActionsToConnectorActions)(n.actions)})),network:e.network??this.connector.network};return(0,_e.assertGasKeyActionsSupported)(this.manifest.features,t.delegateActions.flatMap(n=>n.actions),this.manifest.name),this.executor.call("wallet:signDelegateActions",t)}};$.SandboxWallet=ne;$.default=ne});var je=h(oe=>{"use strict";Object.defineProperty(oe,"__esModule",{value:!0});oe.InjectedWallet=void 0;var Ee=O(),Me=q(),Ne=class{connector;wallet;constructor(e,t){this.connector=e,this.wallet=t}get manifest(){return this.wallet.manifest}async signIn({addFunctionCallKey:e,network:t}){return this.wallet.signIn({network:t??this.connector.network,addFunctionCallKey:e})}async signInAndSignMessage(e){return this.wallet.signInAndSignMessage({network:e?.network??this.connector.network,addFunctionCallKey:e.addFunctionCallKey,messageParams:e.messageParams})}async signOut(e){await this.wallet.signOut({network:e?.network??this.connector.network})}async getAccounts(e){return this.wallet.getAccounts({network:e?.network??this.connector.network})}async signAndSendTransaction(e){let t=(0,Ee.nearActionsToConnectorActions)(e.actions);(0,Me.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n=e.network??this.connector.network,r=await this.wallet.signAndSendTransaction({...e,actions:t,network:n});if(!r)throw new Error("No result from wallet");return Array.isArray(r.transactions)?r.transactions[0]:r}async signAndSendTransactions(e){let t=e.network??this.connector.network,n=e.transactions.map(s=>({actions:(0,Ee.nearActionsToConnectorActions)(s.actions),receiverId:s.receiverId}));(0,Me.assertGasKeyActionsSupported)(this.manifest.features,n.flatMap(s=>s.actions),this.manifest.name);let r=await this.wallet.signAndSendTransactions({...e,transactions:n,network:t});if(!r)throw new Error("No result from wallet");return Array.isArray(r.transactions)?r.transactions:r}async signMessage(e){return this.wallet.signMessage({...e,network:e.network??this.connector.network})}async signDelegateActions(e){let t=e.delegateActions.map(n=>({...n,actions:(0,Ee.nearActionsToConnectorActions)(n.actions)}));return(0,Me.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(n=>n.actions),this.manifest.name),this.wallet.signDelegateActions({...e,delegateActions:t,network:e.network??this.connector.network})}};oe.InjectedWallet=Ne});var rt=h(re=>{"use strict";Object.defineProperty(re,"__esModule",{value:!0});re.NearWalletsPopup=void 0;var j=X(),sn=fe(),an=be(),ln={id:"custom-wallet",name:"Custom Wallet",icon:"https://www.mynearwallet.com/images/webclip.png",description:"Custom wallet for NEAR.",website:"",version:"1.0.0",executor:"your-executor-url.js",type:"sandbox",platform:{},features:{signMessage:!0,signInWithoutAddKey:!0,signInAndSignMessage:!0,signAndSendTransaction:!0,signAndSendTransactions:!0,signDelegateActions:!0},permissions:{storage:!0,allowsOpen:[]}},We=class extends an.Popup{delegate;constructor(e){super(e),this.delegate=e,this.update({wallets:e.wallets,showSettings:!1})}handlers(){super.handlers(),this.addListener(".settings-button","click",()=>this.update({showSettings:!0})),this.addListener(".back-button","click",()=>this.update({showSettings:!1})),this.root.querySelectorAll(".connect-item").forEach(e=>{e instanceof HTMLDivElement&&this.addListener(e,"click",()=>this.delegate.onSelect(e.dataset.type))}),this.root.querySelectorAll(".remove-wallet-button").forEach(e=>{e instanceof SVGSVGElement&&this.addListener(e,"click",async t=>{t.stopPropagation(),await this.delegate.onRemoveDebugManifest(e.dataset.type);let n=this.state.wallets.filter(r=>r.id!==e.dataset.type);this.update({wallets:n})})}),this.addListener(".add-debug-manifest-button","click",async()=>{try{let e=this.root.querySelector("#debug-manifest-input")?.value??"",t=await this.delegate.onAddDebugManifest(e);this.update({showSettings:!1,wallets:[t,...this.state.wallets]})}catch(e){alert(`Something went wrong: ${e}`)}})}create(){super.create({show:!0})}walletDom(e){let t=(0,j.html)`
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
    `;return(0,j.html)`
      <div class="connect-item" data-type="${e.id}">
        <img style="background: #333" src="${e.icon}" alt="${e.name}" />
        <div class="connect-item-info">
          <span>${e.name}</span>
          <span class="wallet-address">${(0,sn.parseUrl)(e.website)?.hostname}</span>
        </div>
        ${e.debug?t:""}
      </div>
    `}get footer(){if(!this.delegate.footer)return"";let{icon:e,heading:t,link:n,linkText:r}=this.delegate.footer;return(0,j.html)`
      <div class="footer">
        ${e?(0,j.html)`<img src="${e}" alt="${t}" />`:""}
        <p>${t}</p>
        <a class="get-wallet-link" href="${n}" target="_blank">${r}</a>
      </div>
    `}get dom(){return this.state.showSettings?(0,j.html)`
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

              <textarea style="width: 100%;" id="debug-manifest-input" rows="10">${JSON.stringify(ln,null,2)}</textarea>
              <button class="add-debug-manifest-button">Add</button>
            </div>

            ${this.footer}
          </div>
        </div>
      `:(0,j.html)`<div class="modal-container">
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
    </div>`}};re.NearWalletsPopup=We});var st=h(Oe=>{"use strict";Object.defineProperty(Oe,"__esModule",{value:!0});var Te=class{dbName;storeName;version;constructor(e,t){this.dbName=e,this.storeName=t,this.version=1}getDb(){return new Promise((e,t)=>{if(typeof window>"u"||typeof indexedDB>"u"){t(new Error("IndexedDB is not available (SSR environment)"));return}let n=indexedDB.open(this.dbName,this.version);n.onerror=r=>{console.error("Error opening database:",r.target.error),t(new Error("Error opening database"))},n.onsuccess=r=>{e(n.result)},n.onupgradeneeded=r=>{let s=n.result;s.objectStoreNames.contains(this.storeName)||s.createObjectStore(this.storeName)}})}async getItem(e){let t=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((n,r)=>{if(!this.storeName){r(new Error("Store name not set"));return}let s=t.transaction(this.storeName,"readonly");s.onerror=c=>r(s.error);let i=s.objectStore(this.storeName).get(e);i.onerror=c=>r(i.error),i.onsuccess=()=>{n(i.result),t.close()}})}async setItem(e,t){let n=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((r,s)=>{if(!this.storeName){s(new Error("Store name not set"));return}let a=n.transaction(this.storeName,"readwrite");a.onerror=l=>s(a.error);let c=a.objectStore(this.storeName).put(t,e);c.onerror=l=>s(c.error),c.onsuccess=()=>{n.close(),r()}})}async removeItem(e){let t=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((n,r)=>{if(!this.storeName){r(new Error("Store name not set"));return}let s=t.transaction(this.storeName,"readwrite");s.onerror=c=>r(s.error);let i=s.objectStore(this.storeName).delete(e);i.onerror=c=>r(i.error),i.onsuccess=()=>{t.close(),n()}})}async keys(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let r=e.transaction(this.storeName,"readonly");r.onerror=i=>n(r.error);let a=r.objectStore(this.storeName).getAllKeys();a.onerror=i=>n(a.error),a.onsuccess=()=>{t(a.result),e.close()}})}async count(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let r=e.transaction(this.storeName,"readonly");r.onerror=i=>n(r.error);let a=r.objectStore(this.storeName).count();a.onerror=i=>n(a.error),a.onsuccess=()=>{t(a.result),e.close()}})}async length(){return this.count()}async clear(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let r=e.transaction(this.storeName,"readwrite");r.onerror=i=>n(r.error);let a=r.objectStore(this.storeName).clear();a.onerror=i=>n(a.error),a.onsuccess=()=>{e.close(),t()}})}};Oe.default=Te});var it=h(W=>{"use strict";var cn=W&&W.__importDefault||function(o){return o&&o.__esModule?o:{default:o}};Object.defineProperty(W,"__esModule",{value:!0});W.NearConnector=void 0;var dn=ge(),un=rt(),hn=ie(),fn=cn(st()),pn=he(),wn=je(),at=Ie(),gn=["https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json","https://cdn.jsdelivr.net/gh/azbang/hot-connector/repository/manifest.json"];function mn(o){return e=>Object.entries(o).length===0?!0:Object.entries(o).filter(([t,n])=>n===!0).every(([t])=>e.manifest.features?.[t]===!0)}var qe=class{storage;events;db;logger;wallets=[];manifest={wallets:[],version:"1.0.0"};features={};network="mainnet";providers={mainnet:[],testnet:[]};walletConnect;footerBranding;excludedWallets=[];autoConnect;cspNonce;whenManifestLoaded;constructor(e){this.db=new fn.default("hot-connector","wallets"),this.storage=e?.storage??new hn.LocalStorage,this.events=e?.events??new dn.EventEmitter,this.logger=e?.logger,this.cspNonce=e?.cspNonce,this.network=e?.network??"mainnet",this.walletConnect=e?.walletConnect,this.autoConnect=e?.autoConnect??!0,this.providers=e?.providers??{mainnet:[],testnet:[]},this.excludedWallets=e?.excludedWallets??[],this.features=e?.features??{},e?.footerBranding!==void 0?this.footerBranding=e?.footerBranding:this.footerBranding={icon:"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%20512%20512%22%20class%3D%22size-7%22%3E%3Crect%20width%3D%22512%22%20height%3D%22512%22%20fill%3D%22%2300ec97%22%20rx%3D%22110%22%2F%3E%3Cpath%20fill%3D%22%23000%22%20d%3D%22M373.89%20106.199a31.95%2031.95%200%200%200-27.213%2015.207l-62.631%2092.979a6.67%206.67%200%200%200-.989%205.001%206.66%206.66%200%200%200%202.837%204.235%206.67%206.67%200%200%200%208.032-.494l61.643-53.47c1.02-.924%202.599-.827%203.523.193.419.473.644%201.074.644%201.697v167.402a2.49%202.49%200%200%201-2.502%202.491%202.48%202.48%200%200%201-1.912-.891L168.976%20117.497a31.93%2031.93%200%200%200-24.356-11.298h-6.508c-17.623%200-31.917%2014.294-31.917%2031.917v235.767c0%2017.623%2014.294%2031.917%2031.917%2031.917a31.94%2031.94%200%200%200%2027.213-15.206l62.631-92.98a6.66%206.66%200%200%200-1.847-9.236%206.67%206.67%200%200%200-8.033.494l-61.643%2053.471c-1.02.923-2.599.826-3.522-.194a2.5%202.5%200%200%201-.634-1.697V173.008a2.49%202.49%200%200%201%202.502-2.492c.731%200%201.439.322%201.912.891l186.313%20223.096a31.95%2031.95%200%200%200%2024.357%2011.297h6.508c17.623%200%2031.927-14.272%2031.938-31.895V138.116c0-17.623-14.294-31.917-31.917-31.917%22%2F%3E%3C%2Fsvg%3E",heading:"NEAR Connector",link:"https://wallet.near.org",linkText:"Don't have a wallet?"},this.whenManifestLoaded=new Promise(async t=>{e?.manifest==null||typeof e.manifest=="string"?this.manifest=await this._loadManifest(e?.manifest).catch(()=>({wallets:[],version:"1.0.0"})):this.manifest=e?.manifest??{wallets:[],version:"1.0.0"};let n=new Set(this.excludedWallets);n.delete("hot-wallet"),this.manifest.wallets=this.manifest.wallets.filter(r=>!(r.permissions.walletConnect&&!this.walletConnect||n.has(r.id))),await new Promise(r=>setTimeout(r,100)),t()}),typeof window<"u"&&(window.addEventListener("near-wallet-injected",this._handleNearWalletInjected),window.dispatchEvent(new Event("near-selector-ready")),window.addEventListener("message",async t=>{t.data.type==="near-wallet-injected"&&(await this.whenManifestLoaded.catch(()=>{}),this.wallets=this.wallets.filter(n=>n.manifest.id!==t.data.manifest.id),this.wallets.unshift(new pn.ParentFrameWallet(this,t.data.manifest)),this.events.emit("selector:walletsChanged",{}),this.autoConnect&&this.connect({walletId:t.data.manifest.id}))})),this.whenManifestLoaded.then(()=>{typeof window<"u"&&window.parent.postMessage({type:"near-selector-ready"},"*"),this.manifest.wallets.forEach(t=>this.registerWallet(t)),this.storage.get("debug-wallets").then(t=>{JSON.parse(t??"[]").forEach(r=>this.registerDebugWallet(r))})})}get availableWallets(){return this.wallets.filter(t=>Object.entries(this.features).every(([n,r])=>!(r&&!t.manifest.features?.[n]))).filter(t=>!(this.network==="testnet"&&!t.manifest.features?.testnet))}_handleNearWalletInjected=e=>{this.wallets=this.wallets.filter(t=>t.manifest.id!==e.detail.manifest.id),this.wallets.unshift(new wn.InjectedWallet(this,e.detail)),this.events.emit("selector:walletsChanged",{})};async _loadManifest(e){let t=e?[e]:gn;for(let n of t){let r=await fetch(n).catch(()=>null);if(!(!r||!r.ok))return await r.json()}throw new Error("Failed to load manifest")}async switchNetwork(e,t){this.network!==e&&(await this.disconnect().catch(()=>{}),this.network=e,await this.connect(t))}async registerWallet(e){if(e.type!=="sandbox")throw new Error("Only sandbox wallets are supported");this.wallets.find(t=>t.manifest.id===e.id)||(this.wallets.push(new at.SandboxWallet(this,e)),this.events.emit("selector:walletsChanged",{}))}async registerDebugWallet(e){let t=typeof e=="string"?JSON.parse(e):e;if(t.type!=="sandbox")throw new Error("Only sandbox wallets type are supported");if(!t.id)throw new Error("Manifest must have an id");if(!t.name)throw new Error("Manifest must have a name");if(!t.icon)throw new Error("Manifest must have an icon");if(!t.website)throw new Error("Manifest must have a website");if(!t.version)throw new Error("Manifest must have a version");if(!t.executor)throw new Error("Manifest must have an executor");if(!t.features)throw new Error("Manifest must have features");if(!t.permissions)throw new Error("Manifest must have permissions");if(this.wallets.find(r=>r.manifest.id===t.id))throw new Error("Wallet already registered");t.debug=!0,this.wallets.unshift(new at.SandboxWallet(this,t)),this.events.emit("selector:walletsChanged",{});let n=this.wallets.filter(r=>r.manifest.debug).map(r=>r.manifest);return this.storage.set("debug-wallets",JSON.stringify(n)),t}async removeDebugWallet(e){this.wallets=this.wallets.filter(n=>n.manifest.id!==e);let t=this.wallets.filter(n=>n.manifest.debug).map(n=>n.manifest);this.storage.set("debug-wallets",JSON.stringify(t)),this.events.emit("selector:walletsChanged",{})}async selectWallet({features:e={}}={}){return await this.whenManifestLoaded.catch(()=>{}),new Promise((t,n)=>{let r=new un.NearWalletsPopup({footer:this.footerBranding,wallets:this.availableWallets.filter(mn(e)).map(s=>s.manifest),onRemoveDebugManifest:async s=>this.removeDebugWallet(s),onAddDebugManifest:async s=>this.registerDebugWallet(s),onReject:()=>(n(new Error("User rejected")),r.destroy()),onSelect:s=>(t(s),r.destroy())});r.create()})}async connect(e={}){let t=e.walletId,n=e.signMessageParams;await this.whenManifestLoaded.catch(()=>{}),t||(t=await this.selectWallet({features:{signInAndSignMessage:e.signMessageParams!=null?!0:void 0,signInWithFunctionCallKey:e.addFunctionCallKey!=null?!0:void 0}}));try{let r=await this.wallet(t);this.logger?.log("Wallet available to connect",r),await this.storage.set("selected-wallet",t),this.logger?.log(`Set preferred wallet, try to signIn${n!=null?" (with signed message)":""}`,t);let s;if(e.addFunctionCallKey!=null&&(this.logger?.log("Adding function call access key during sign in with params",e.addFunctionCallKey),s={...e.addFunctionCallKey,gasAllowance:e.addFunctionCallKey.gasAllowance??{amount:"250000000000000000000000",kind:"limited"}}),n!=null){let a=await r.signInAndSignMessage({addFunctionCallKey:s,messageParams:n,network:this.network});if(!a?.length)throw new Error("Failed to sign in");this.logger?.log("Signed in to wallet (with signed message)",t,a),this.events.emit("wallet:signInAndSignMessage",{wallet:r,accounts:a,success:!0}),this.events.emit("wallet:signIn",{wallet:r,accounts:a.map(i=>({accountId:i.accountId,publicKey:i.publicKey})),success:!0,source:"signInAndSignMessage"})}else{let a=await r.signIn({addFunctionCallKey:s,network:this.network});if(!a?.length)throw new Error("Failed to sign in");this.logger?.log("Signed in to wallet",t,a),this.events.emit("wallet:signIn",{wallet:r,accounts:a,success:!0,source:"signIn"})}return r}catch(r){throw this.logger?.log("Failed to connect to wallet",r),r}}async disconnect(e){e||(e=await this.wallet()),await e.signOut({network:this.network}),await this.storage.remove("selected-wallet"),this.events.emit("wallet:signOut",{success:!0})}async getConnectedWallet(){await this.whenManifestLoaded.catch(()=>{});let e=await this.storage.get("selected-wallet"),t=this.wallets.find(r=>r.manifest.id===e);if(!t)throw new Error("No wallet selected");let n=await t.getAccounts();if(!n?.length)throw new Error("No accounts found");return{wallet:t,accounts:n}}async wallet(e){if(await this.whenManifestLoaded.catch(()=>{}),!e)return this.getConnectedWallet().then(({wallet:n})=>n).catch(async()=>{throw await this.storage.remove("selected-wallet"),new Error("No accounts found")});let t=this.wallets.find(n=>n.manifest.id===e);if(!t)throw new Error("Wallet not found");return t}async use(e){await this.whenManifestLoaded.catch(()=>{}),this.wallets=this.wallets.map(t=>new Proxy(t,{get(n,r,s){let a=Reflect.get(n,r,s);if(r in e&&typeof a=="function"){let i=e[r];return function(...c){let l=()=>a.apply(n,c);return c.length>0?i.call(this,...c,l):i.call(this,void 0,l)}}return a}}))}on(e,t){this.events.on(e,t)}once(e,t){this.events.once(e,t)}off(e,t){this.events.off(e,t)}removeAllListeners(e){this.events.removeAllListeners(e)}};W.NearConnector=qe});var ct=h(w=>{"use strict";Object.defineProperty(w,"__esModule",{value:!0});w.assertGasKeyActionsSupported=w.isGasKeyAction=w.nearActionsToConnectorActions=w.NearConnector=w.InjectedWallet=w.SandboxWallet=w.ParentFrameWallet=w.LocalStorage=void 0;var yn=ie();Object.defineProperty(w,"LocalStorage",{enumerable:!0,get:function(){return yn.LocalStorage}});var bn=he();Object.defineProperty(w,"ParentFrameWallet",{enumerable:!0,get:function(){return bn.ParentFrameWallet}});var xn=Ie();Object.defineProperty(w,"SandboxWallet",{enumerable:!0,get:function(){return xn.SandboxWallet}});var kn=je();Object.defineProperty(w,"InjectedWallet",{enumerable:!0,get:function(){return kn.InjectedWallet}});var vn=it();Object.defineProperty(w,"NearConnector",{enumerable:!0,get:function(){return vn.NearConnector}});var Sn=O();Object.defineProperty(w,"nearActionsToConnectorActions",{enumerable:!0,get:function(){return Sn.nearActionsToConnectorActions}});var lt=q();Object.defineProperty(w,"isGasKeyAction",{enumerable:!0,get:function(){return lt.isGasKeyAction}});Object.defineProperty(w,"assertGasKeyActionsSupported",{enumerable:!0,get:function(){return lt.assertGasKeyActionsSupported}})});var wt=At(ct(),1);function dt(o){let e=new Map,t=new Set(o.nodes.map(a=>a.id));for(;t.size;){let a=!1;for(let i of t){let c=o.links.filter(l=>l.to===i).map(l=>l.from);c.some(l=>t.has(l))||(e.set(i,c.length?Math.max(...c.map(l=>e.get(l)||0))+1:0),t.delete(i),a=!0)}if(!a){for(let i of t)e.set(i,0);break}}let n=[];for(let a of o.nodes){let i=e.get(a.id)||0;(n[i]||=[]).push(a)}let r=Math.max(320,...n.map(a=>a.length*204+24));return{nodes:n.flatMap((a,i)=>a.map((c,l)=>({...c,x:(r-a.length*204)/2+l*204+10,y:16+i*98}))),links:o.links,width:r,height:Math.max(100,n.length*98)}}var An="http://www.w3.org/2000/svg",Le={pending:"Waiting",running:"Running",done:"Done",error:"Failed",skipped:"Skipped",gated:"Gate closed"},k=(o,e,t)=>{let n=document.createElementNS(An,o);for(let[r,s]of Object.entries(e))n.setAttribute(r,String(s));return t!=null&&(n.textContent=t),n};function ut(o,e){let t=dt(e),n=new Map(t.nodes.map(s=>[s.id,s])),r=k("svg",{viewBox:`0 0 ${t.width} ${t.height}`,width:t.width,height:t.height,role:"img","aria-label":e.nodes.map(s=>`${s.name}: ${Le[s.status]||s.status}`).join("; ")});for(let s of t.links){let a=n.get(s.from),i=n.get(s.to);if(!a||!i)continue;let c=a.x+92,l=a.y+68,f=i.x+92,u=i.y;r.append(k("path",{d:`M${c} ${l} C${c} ${l+18},${f} ${u-18},${f} ${u}`,class:`workflow-wire${["done","gated"].includes(a.status)?" is-done":""}`}))}for(let s of t.nodes){let a=k("g",{transform:`translate(${s.x},${s.y})`,class:"workflow-node","data-status":s.status,"data-node":s.id}),i=`${s.name} \xB7 ${s.type} \xB7 ${Le[s.status]||s.status}${s.detail?` \xB7 ${s.detail}`:""}`;a.append(k("title",{},i),k("rect",{width:184,height:68,rx:9}),k("circle",{cx:14,cy:19,r:3.5,class:"workflow-dot"}),k("text",{x:25,y:23,class:"workflow-name"},s.name.length>21?s.name.slice(0,20)+"\u2026":s.name),k("text",{x:14,y:48,class:"workflow-kind"},s.type),k("text",{x:172,y:48,"text-anchor":"end",class:"workflow-state"},s.status==="running"&&s.detail==="queued"?`Queued${s.queuePosition!=null?` #${s.queuePosition}`:""}`:Le[s.status]||s.status)),r.append(a)}o.replaceChildren(r)}function ht(o){let e=String(o??"0");if(!/^\d+(\.\d+)?$/.test(e))return e;let[t,n=""]=e.split(".");if(n.length<=6)return e;let r=BigInt(t)*1000000n+BigInt(n.slice(0,6))+(n[6]>="5"?1n:0n);return r===0n&&/[1-9]/.test(e)?"<0.000001":`\u2248 ${`${r/1000000n}.${String(r%1000000n).padStart(6,"0")}`.replace(/\.?0+$/,"")}`}function Cn(o){let e=[...o.content||[]];return o.structuredContent?.receipt?.outcome==="succeeded"&&/^Paid [\d.]+ (?:USDC|NEAR)\b/.test(e.at(-1)?.text||"")&&(e.pop(),e.at(-1)?.type==="text"&&/^charged: \$/.test(e.at(-1).text)&&e.pop()),e.filter(t=>t.type==="text").map(t=>t.text).join(`

`)}function ft(o,{collapseFinished:e=!0,origin:t=location.origin}={}){let n=c=>document.getElementById(`${o}-${c}`),r,s,a,i=c=>{if(!c)return;let l=Math.max(0,Math.floor(((c.finishedAt||Date.now())-c.startedAt)/1e3));n("elapsed").textContent=`${Math.floor(l/60)}:${String(l%60).padStart(2,"0")}`};return{elapsed:i,render({payment:c={},workflow:l,result:f,receipt:u=f?.structuredContent?.receipt}){if(n("workflow").hidden=!l,l){let y=JSON.stringify(l);y!==s&&(ut(n("workflow-graph"),l),s=y);let m=l.nodes.filter(d=>["done","skipped","gated","error"].includes(d.status)).length,p=`${c.paymentId}:${!!l.finishedAt}`;a!==p&&(n("workflow").open=!e||!l.finishedAt,a=p),n("workflow-count").textContent=`${m} / ${l.nodes.length} steps finished`,i(l)}if(n("totals").hidden=!u,u){for(let[y,m]of[["paid",u.deposit],["charged",u.charged],["returned",u.refund]]){let p=m?.amount??m?.near??"0",d=u.asset||c.asset||"NEAR";n(`total-${y}`).textContent=`${ht(p)} ${d}`,n(`total-${y}`).title=`${p} ${d} (exact)`}n("refund-state").textContent=u.refund.status==="sent"?"Back in your wallet":u.refund.status==="pending"?"Returning to your wallet\u2026":["none","skipped"].includes(u.refund.status)?"No change due":`Refund ${u.refund.status}`}if(n("result").hidden=!f,!f)return;let I=Cn(f),T=JSON.stringify(f.content);if(T!==r){let y=I.split(`
`).filter(m=>!/^[^\n]*https?:\/\/[^\s]+\/out\/[^\s]+$/.test(m.trim())).join(`
`).trim();n("output").textContent=y,n("output").hidden=!y,n("raw-output").textContent=I,n("media").replaceChildren(),n("output-links").replaceChildren();for(let m of[...new Set(I.match(/https?:\/\/[^\s<>"')]+/g)||[])]){let p;try{p=new URL(m)}catch{continue}let d=/^\/out\/[^/]+\.(png|jpe?g|webp|gif|mp4|webm|mp3|wav|ogg)$/i.exec(p.pathname),A=/^\/out\/[^/]+\.(glb|gltf|obj|stl|ply|fbx|zip)$/i.test(p.pathname),Re=d||A?new URL(p.pathname,t).href:p.href;if(d){let Ue=/^(png|jpe?g|webp|gif)$/i.test(d[1])?"img":/^(mp4|webm)$/i.test(d[1])?"video":"audio",M=document.createElement(Ue);M.src=Re,Ue==="img"?(M.alt="Generated workflow result",M.loading="lazy"):(M.controls=!0,M.preload="metadata"),n("media").append(M)}let E=document.createElement("a");E.href=Re,E.target="_blank",E.rel="noopener noreferrer",E.textContent=A?"Download 3D model \u2197":d?"Download result \u2197":"Open result \u2197",A&&(E.download=p.pathname.split("/").at(-1)),n("output-links").append(E)}r=T}n("receipt").textContent=JSON.stringify(u,null,2),n("transactions").replaceChildren();for(let[y,m]of[["Payment",u?.deposit],["Refund",u?.refund],["Creator payout",u?.authorPayout]]){if(!m?.explorerUrl)continue;let p=new URL(m.explorerUrl);if(!["https:","http:"].includes(p.protocol))continue;let d=document.createElement("a");d.href=p.href,d.target="_blank",d.rel="noopener noreferrer",d.textContent=`${y} transaction \u2197`,n("transactions").append(d)}}}}function pt({initial:o,update:e,fetch:t=globalThis.fetch,EventSource:n=globalThis.EventSource,pause:r=s=>new Promise(a=>setTimeout(a,s))}){let s=encodeURIComponent(o.paymentId),a=o,i=null,c=null,l=!1,f=!1,u,I=d=>["settled","failed","rejected"].includes(d?.status),T=()=>["unknown","expired"].includes(a?.status)||I(a)&&a.receipt?.refund?.status!=="pending"&&i,y=()=>{f=!0,u?.close()};async function m(d){f||(a=d,e(a,i),I(a)&&!i&&(c||(c=(async()=>{let A=await t(`/near/result/${s}`,{cache:"no-store",signal:AbortSignal.timeout(3e4)});if(!A.ok)throw new Error("The result is not available yet. Reconnecting to the same paid run\u2026");A.status!==202&&(i=await A.json(),e(a,i))})().finally(()=>{c=null})),await c),T()&&y())}async function p(){if(!(l||f)){l=!0,u?.close();try{for(;!f;){try{let d=await t(`/near/status/${s}?wait=1`,{cache:"no-store",signal:AbortSignal.timeout(3e4)});if(!d.ok&&d.status!==404)throw new Error("Run monitor is reconnecting");await m(d.status===404?{paymentId:o.paymentId,status:"unknown"}:await d.json())}catch{}f||await r(1e3)}}finally{l=!1}}}return m(o).catch(()=>{p()}),!T()&&n?(u=new n(`/near/watch/${s}?run=1`),u.addEventListener("status",d=>{try{m(JSON.parse(d.data)).then(()=>{a.done&&!f&&p()}).catch(()=>{p()})}catch{p()}}),u.onerror=()=>{p()}):!n&&!f&&p(),{stop:y,apply:m}}var $n=document.querySelector("#near-payment"),g=JSON.parse($n.dataset.payment),Ke=document.querySelector("#near-pay"),D=document.querySelector("#near-status"),F=document.querySelector("#near-error"),P=document.querySelector("#near-confirm"),De=`nanoodle-near:${g.paymentId}`,x=g,gt=null,mt=ft("pay"),_=!1,b=null;try{b=JSON.parse(localStorage.getItem(De))}catch{}var se=o=>{b=o;try{o?localStorage.setItem(De,JSON.stringify(o)):localStorage.removeItem(De)}catch{}};function S(o){x=o;let e=g.asset==="USDC"?"USDC":"NEAR",t={pending:"Ready to pay. Approve the deposit in your NEAR wallet.",paid:"Payment confirmed. Your agent is continuing \u2014 no further payment needed.",running:"Payment confirmed. Your workflow is running.",settled:`Complete. Unused ${e} is returned to the wallet that paid.`,failed:"The run failed. Your deposit is being refunded to the wallet that paid.",rejected:`This payment could not buy the run. Received ${e} is being refunded.`,expired:"This quote expired. Ask your agent for a fresh quote.",unknown:"Unknown payment. Ask your agent for a fresh quote."};D.textContent=t[o.status]||o.status;let n=["settled","failed","rejected"].includes(o.status);document.querySelector("#near-title").textContent=o.status==="pending"?`Pay in ${e}`:n?o.receipt?.outcome==="succeeded"?"Your result":"Run finished":"Your workflow",document.querySelector("#near-deposit").open=o.status==="pending",document.querySelector("#near-manual").hidden=o.status!=="pending",document.querySelector("#near-note").textContent=o.status==="pending"?"Keep this page open for the live workflow, result and receipt. Your agent continues automatically after payment.":o.status==="paid"?"Waiting for your agent to start this paid workflow. No further payment is needed.":o.status==="running"?"Follow each step here. Your result appears on this page when it is ready.":"This page shows the result and receipt for your original payment. Refreshing never starts another run.",mt.render({payment:g,workflow:o.workflow,receipt:o.receipt,result:gt}),o.receipt?.refund?.status==="pending"&&(D.textContent+=" The refund is pending; it will retry automatically."),o.receipt?.refund?.status==="failed_permanent"&&(D.textContent+=` Contact the operator with payment id ${g.paymentId} about the refund.`),Ke.disabled=_||o.status!=="pending"||!!b,Ke.textContent=b?"Payment submitted \u2014 confirm below if needed":"Connect wallet & pay",b&&o.status==="pending"&&(D.textContent="A wallet payment was already requested. Confirm that transfer below; do not send it twice.")}async function Fe(o,e){F.textContent="";for(let t=0;t<10;t++){D.textContent="Confirming your transfer on NEAR\u2026";let n=await fetch(`/near/pay/${encodeURIComponent(g.paymentId)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({txHash:o,senderId:e})}),r=await n.json();if(r.status&&S(r),n.ok)return;if(r.error&&/not found as final|not final|could not be reached/.test(r.error)&&t<9){await new Promise(s=>setTimeout(s,3e3));continue}throw new Error(r.error||"Confirmation failed. Retry confirming the same transfer below.")}}Ke.addEventListener("click",async()=>{if(!(_||b||x.status!=="pending")){_=!0,F.textContent="",S(x);try{let o=await fetch(`/near/status/${encodeURIComponent(g.paymentId)}`,{cache:"no-store"});if(S(await o.json()),!o.ok||x.status!=="pending")return;let t=await new wt.NearConnector({network:g.network,features:{signAndSendTransaction:!0,signInWithoutAddKey:!0}}).connect(),r=(await t.getAccounts({network:g.network}))[0]?.accountId;if(!r)throw new Error("The wallet did not return a NEAR account.");se({senderId:r});let a=(await t.signAndSendTransaction({network:g.network,signerId:r,receiverId:g.asset==="USDC"?g.tokenContract:g.payTo,actions:g.asset==="USDC"?[{type:"FunctionCall",params:{methodName:"ft_transfer",args:{receiver_id:g.payTo,amount:g.amountAtomic},gas:"30000000000000",deposit:"1"}}]:[{type:"Transfer",params:{deposit:g.amountYocto}}]}))?.transaction?.hash;if(!a)throw new Error("Check your wallet history and confirm the transaction below. Do not send the deposit again.");se({senderId:r,txHash:a}),P.elements.senderId.value=r,P.elements.txHash.value=a,await Fe(a,r)}catch(o){/reject|cancel|denied/i.test(o.message)&&!b?.txHash&&se(null),F.textContent=o.message}finally{_=!1,S(x)}}});P.addEventListener("submit",async o=>{if(o.preventDefault(),_)return;_=!0;let e=P.elements.senderId.value.trim(),t=P.elements.txHash.value.trim();se({senderId:e,txHash:t}),S(x);try{await Fe(t,e)}catch(n){F.textContent=n.message}finally{_=!1,S(x)}});S(x);b?.senderId&&(P.elements.senderId.value=b.senderId);b?.txHash&&(P.elements.txHash.value=b.txHash,x.status==="pending"&&Fe(b.txHash,b.senderId).catch(o=>{F.textContent=o.message}));pt({initial:g,update(o,e){gt=e,S(o)}});setInterval(()=>{x.workflow&&!x.workflow.finishedAt&&mt.elapsed(x.workflow)},1e3);
