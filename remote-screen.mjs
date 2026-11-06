// Private screen bytes stay in browser memory. No URL in device data is fetched.
export const SCREEN_IMAGE_LIMIT=128*1024;
export const SCREEN_CHUNK_BYTES=512;
export const SCREEN_CHUNK_LIMIT=SCREEN_IMAGE_LIMIT/SCREEN_CHUNK_BYTES;
export const SCREEN_TRANSFER_TIMEOUT_MS=120000;
const integer = (value,min,max) => Number.isSafeInteger(value) && value>=min && value<=max;
const imageKind = value => value?.kind==='wechat_qr' || value?.kind==='wechat_verify';
const sameToken = (left,right) => !!left && !!right && left.generation===right.generation && left.revision===right.revision;
const sameImage = (left,right) => sameToken(left,right) && ['kind','mime','bytes','chunks','width'].every(key=>left[key]===right[key]);

export function validateRemoteDisplay(value) {
  if (!value || !['none','status','wechat_qr','wechat_verify'].includes(value.kind) ||
      !integer(value.generation,0,0xffffffff) || !integer(value.revision,1,0x7fffffff) ||
      typeof value.text!=='string' || new TextEncoder().encode(value.text).length>2048 ||
      !integer(value.bytes,0,SCREEN_IMAGE_LIMIT) || !integer(value.chunks,0,SCREEN_CHUNK_LIMIT) || !integer(value.width,0,177)) throw new Error('设备屏幕信息格式不匹配');
  if (!imageKind(value)) {
    if (value.mime!=='' || value.bytes!==0 || value.chunks!==0 || value.width!==0) throw new Error('文字屏幕不能包含图像');
  } else {
    if (!['image/png','image/jpeg','application/x-lumi-qr'].includes(value.mime) || value.bytes<1 || value.chunks!==Math.ceil(value.bytes/SCREEN_CHUNK_BYTES)) throw new Error('二维码图像格式或长度无效');
    if (value.kind==='wechat_verify' && value.mime!=='application/x-lumi-qr') throw new Error('验证屏幕必须使用本地二维码矩阵');
    if (value.mime==='application/x-lumi-qr') {
      if (value.kind!=='wechat_verify' || value.width<21 || (value.width-17)%4!==0 || value.bytes!==Math.ceil(value.width*value.width/8)) throw new Error('验证二维码矩阵无效');
    } else if (value.width!==0) throw new Error('压缩图像不能声明矩阵宽度');
  }
  return value;
}

function decodeChunk(data) {
  if (typeof data!=='string' || data.length===0 || data.length>684 || data.length%4!==0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('二维码数据编码无效');
  const text=atob(data);
  if (btoa(text)!==data) throw new Error('二维码数据编码不规范');
  return Uint8Array.from(text,char=>char.charCodeAt(0));
}

function matchesMime(metadata,bytes) {
  if (metadata.mime==='image/png') return [137,80,78,71,13,10,26,10].every((byte,index)=>bytes[index]===byte);
  if (metadata.mime==='image/jpeg') return bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  const unused=bytes.length*8-metadata.width*metadata.width;
  return unused===0 || (bytes.at(-1)&((1<<unused)-1))===0;
}

export class ScreenImageAssembler {
  constructor({onImage=()=>{},onFailure=()=>{},now=()=>Date.now(),timeoutMs=SCREEN_TRANSFER_TIMEOUT_MS}={}) {
    this.onImage=onImage;this.onFailure=onFailure;this.now=now;this.timeoutMs=timeoutMs;this.reset();
  }
  reset() {this.current=null;this.buffer=null;this.index=0;this.started=0;this.failed=false;this.complete=false;}
  update(metadata) {
    if (metadata==null) {this.reset();return true;}
    validateRemoteDisplay(metadata);
    if (this.current) {
      if (metadata.generation!==this.current.generation) {
        const distance=(metadata.generation-this.current.generation)>>>0;
        if (distance>=0x80000000) return false;
      } else if (metadata.revision<this.current.revision) return false;
      if (sameToken(metadata,this.current)) {
        if (!sameImage(metadata,this.current)) {this.fail('同一屏幕版本的图像信息发生变化');return false;}
        this.current={...metadata};return true;
      }
    }
    this.reset();this.current={...metadata};
    if (imageKind(metadata)) {this.buffer=new Uint8Array(metadata.bytes);this.started=this.now();}
    return true;
  }
  fail(reason) {
    if (!imageKind(this.current) || this.failed || this.complete) return;
    this.failed=true;this.buffer=null;this.onFailure({...this.current,reason});
  }
  expire() {if (this.buffer && this.now()-this.started>=this.timeoutMs) this.fail('二维码接收超时，请重新获取');}
  push(message) {
    if (!message || message.v!==1 || message.type!=='screen_chunk') throw new Error('设备屏幕数据格式无效');
    if (!sameToken(message,this.current) || !this.buffer || this.failed || this.complete) return false;
    this.expire();if (this.failed) return false;
    try {
      // A secure sync/subscription starts the same image again, always at zero.
      // Keep the original start time so retransmission cannot defeat the bound.
      if (message.index===0 && this.index>0) this.index=0;
      if (!integer(message.index,0,SCREEN_CHUNK_LIMIT-1) || message.index!==this.index || message.total!==this.current.chunks ||
          Object.keys(message).some(key=>!['v','type','generation','revision','index','total','data'].includes(key))) throw new Error('二维码数据顺序不匹配');
      const bytes=decodeChunk(message.data);
      const expected=Math.min(SCREEN_CHUNK_BYTES,this.current.bytes-this.index*SCREEN_CHUNK_BYTES);
      if (bytes.length!==expected) throw new Error('二维码数据长度不匹配');
      this.buffer.set(bytes,this.index*SCREEN_CHUNK_BYTES);this.index++;
      if (this.index===this.current.chunks) {
        if (!matchesMime(this.current,this.buffer)) throw new Error('二维码内容与图像格式不匹配');
        const completed={metadata:{...this.current},bytes:this.buffer};
        this.buffer=null;this.complete=true;this.onImage(completed);
      }
      return true;
    } catch (error) {this.fail(error.message);return false;}
  }
}

export class RemoteScreenRenderer {
  constructor({surface,image,canvas,text,progress=null,send,isVisible,raf=callback=>requestAnimationFrame(callback),
               createUrl=blob=>URL.createObjectURL(blob),revokeUrl=url=>URL.revokeObjectURL(url),onError=()=>{}}) {
    Object.assign(this,{surface,image,canvas,text,progress,send,isVisible,raf,createUrl,revokeUrl,onError});this.clear();
  }
  clear() {
    this.epoch=(this.epoch||0)+1;
    this.current=null;this.loaded=false;this.failed=false;this.acknowledged=false;this.ackPending=false;this.failureSent=false;this.framePending=false;
    this.image.onload=null;this.image.onerror=null;this.image.hidden=true;this.canvas.hidden=true;
    this.image.removeAttribute('src');
    if (this.url) this.revokeUrl(this.url);
    this.url=null;this.text.textContent='';this.surface.hidden=true;
    if (this.progress) this.progress.hidden=true;
  }
  update(metadata) {
    if (metadata && sameImage(metadata,this.current)) {this.current={...metadata};this.text.textContent=metadata.text;return;}
    this.clear();
    if (!metadata || metadata.kind==='none') return;
    this.current={...metadata};this.text.textContent=metadata.text;this.surface.hidden=false;
    if (this.progress) this.progress.hidden=!imageKind(metadata);
  }
  present({metadata,bytes}) {
    if (!sameImage(metadata,this.current) || this.failed || this.loaded || this.url) return;
    const token=this.current,epoch=this.epoch;
    try {
      if (metadata.mime==='application/x-lumi-qr') {
        const width=metadata.width,scale=Math.max(1,Math.floor(256/(width+8)));
        this.canvas.width=this.canvas.height=(width+8)*scale;
        const context=this.canvas.getContext('2d');if (!context) throw new Error('无法绘制二维码');
        context.fillStyle='#fff';context.fillRect(0,0,this.canvas.width,this.canvas.height);context.fillStyle='#000';
        for(let y=0;y<width;y++) for(let x=0;x<width;x++) {
          const bit=y*width+x;if (bytes[bit>>3]&(0x80>>(bit&7))) context.fillRect((x+4)*scale,(y+4)*scale,scale,scale);
        }
        this.canvas.hidden=false;this.loaded=true;if(this.progress)this.progress.hidden=true;this.checkVisible();
      } else {
        this.url=this.createUrl(new Blob([bytes],{type:metadata.mime}));
        this.image.onload=()=>{
          if (epoch!==this.epoch || !sameToken(token,this.current) || this.failed) return;
          const maximum=metadata.mime==='image/jpeg'?4096:512;
          if (this.image.naturalWidth<64 || this.image.naturalWidth>maximum || this.image.naturalHeight!==this.image.naturalWidth) {this.fail({...token,reason:'二维码尺寸无效'});return;}
          this.image.hidden=false;this.loaded=true;if(this.progress)this.progress.hidden=true;this.checkVisible();
        };
        this.image.onerror=()=>{if(epoch===this.epoch)this.fail({...token,reason:'二维码图像解码失败，请重新获取'});};
        this.image.src=this.url;
      }
    } catch(error) {this.fail({...token,reason:error.message});}
  }
  checkVisible() {
    if (!this.loaded || this.failed || this.acknowledged || this.ackPending || this.framePending || !this.current || !this.isVisible()) return;
    const token=this.current,epoch=this.epoch;this.framePending=true;
    this.raf(()=>this.raf(()=>{
      if (epoch!==this.epoch || !sameToken(token,this.current)) return;
      this.framePending=false;
      if (!this.loaded || this.failed || !this.isVisible() || this.acknowledged || this.ackPending) return;
      this.ackPending=true;
      let sent=false;
      Promise.resolve().then(()=>{
        if (epoch!==this.epoch || !sameToken(token,this.current) || !this.isVisible()) return;
        sent=true;return this.send('display_ack',token.revision);
      }).then(()=>{
        if (sent && epoch===this.epoch && sameToken(token,this.current)) this.acknowledged=true;
      }).catch(this.onError).finally(()=>{if (epoch===this.epoch && sameToken(token,this.current)) this.ackPending=false;});
    }));
  }
  fail(failure) {
    if (!sameToken(failure,this.current) || this.failureSent || this.acknowledged) return;
    this.failed=true;this.failureSent=true;this.loaded=false;this.image.hidden=true;this.canvas.hidden=true;
    if (this.progress) this.progress.hidden=true;
    this.text.textContent=failure.reason || '二维码未能显示，请重新获取';
    const token=this.current,epoch=this.epoch;
    Promise.resolve().then(()=>{if (epoch===this.epoch && sameToken(token,this.current)) return this.send('display_fail',token.revision);}).catch(this.onError);
  }
}
