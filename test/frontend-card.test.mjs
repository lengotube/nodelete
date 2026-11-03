import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

function appHarness(handler) {
  let now = 1000000;
  const opened = [], timers = new Map(); let timerId = 0;
  class Clock extends Date { static now() { return now; } }
  const element = { innerHTML:'', classList:{toggle(){}}, setAttribute(){}, addEventListener(){}, querySelector(){return {textContent:''}} };
  const tg = {initData:'signed-user',ready(){},expand(){},openLink(url){opened.push(url)},showAlert(){}};
  const context = {
    window:{Telegram:{WebApp:tg}}, document:{querySelector(){return element},querySelectorAll(){return []},documentElement:{},body:element},
    location:{search:'',href:'https://example.test/'}, history:{replaceState(){}},
    localStorage:{getItem(){return null},setItem(){}}, URL, URLSearchParams, Date:Clock, AbortController,
    setTimeout(fn, delay){const id=++timerId;timers.set(id,{fn,delay});return id},clearTimeout(id){timers.delete(id)},
    scrollTo(){}, alert(){}, navigator:{}, fetch:handler
  };
  const script=readFileSync(new URL('../public/app.js',import.meta.url),'utf8')+'\nglobalThis.testAPI={state,prepareCardCheckout,requestCardCheckout,invalidateCardCheckout,getPreparation:()=>cardPreparation};';
  runInNewContext(script,context);
  return { ...context.testAPI, opened, timers, advance(ms){now+=ms} };
}
const ok = (data) => ({ok:true,json:async()=>data});
const quote = {ok:true,weeklyPlan:'lite',weeklyPrice:10};

test('card link opens synchronously after preparation and expires safely', async()=>{
  let calls=[];
  const app=appHarness(async(url,options)=>{if(url!=='/api/card-checkout')return ok({ok:true});const body=JSON.parse(options.body);calls.push(body);return ok(body.action==='quote'?quote:{ok:true,url:'https://checkout.example/pay/secret'});});
  app.state.page='plans';app.state.paymentMethod='card';app.state.personalPlan='lite';
  await app.prepareCardCheckout();
  assert.equal(app.getPreparation().status,'ready');
  assert.equal(calls[1].plan,'lite');
  app.requestCardCheckout();
  assert.deepEqual(app.opened,['https://checkout.example/pay/secret']);
  app.advance(50*60*1000);
  app.requestCardCheckout();
  assert.equal(app.opened.length,1);
  assert.equal(app.getPreparation().status,'loading');
});

test('late card response cannot replace link for a different plan', async()=>{
  let release;
  const blocked=new Promise(resolve=>{release=resolve});
  const app=appHarness(async(url,options)=>{if(url!=='/api/card-checkout')return ok({ok:true});const body=JSON.parse(options.body);if(body.action==='quote')return ok(quote);if(body.plan==='plus'){await blocked;return ok({ok:true,url:'https://checkout.example/pay/plus'});}return ok({ok:true,url:'https://checkout.example/pay/prime'});});
  app.state.page='plans';app.state.paymentMethod='card';app.state.personalPlan='plus';
  const first=app.prepareCardCheckout();
  await new Promise(resolve=>setImmediate(resolve));
  app.state.personalPlan='prime';
  await app.prepareCardCheckout();
  release();await first;
  assert.equal(app.getPreparation().plan,'prime');
  app.requestCardCheckout();
  assert.deepEqual(app.opened,['https://checkout.example/pay/prime']);
});

test('preparation failure is recoverable and never opens an unprepared link', async()=>{
  let fail=true;
  const app=appHarness(async(url,options)=>{if(url!=='/api/card-checkout')return ok({ok:true});if(fail)return {ok:false,json:async()=>({message:'Попробуйте позже'})};const body=JSON.parse(options.body);return ok(body.action==='quote'?quote:{ok:true,url:'https://checkout.example/pay/retry'});});
  app.state.page='plans';app.state.paymentMethod='card';
  await app.prepareCardCheckout();assert.equal(app.getPreparation().status,'error');assert.equal(app.opened.length,0);
  fail=false;await app.prepareCardCheckout();app.requestCardCheckout();assert.equal(app.opened.length,1);
});

test('weekly price 79 is passed through as the regular plan', async()=>{
  const calls=[];
  const app=appHarness(async(url,options)=>{if(url!=='/api/card-checkout')return ok({ok:true});const body=JSON.parse(options.body);calls.push(body);return ok(body.action==='quote'?{ok:true,weeklyPlan:'lite_regular',weeklyPrice:79}:{ok:true,url:'https://checkout.example/pay/regular'});});
  app.state.page='plans';app.state.paymentMethod='card';app.state.personalPlan='lite';
  await app.prepareCardCheckout();
  assert.equal(app.state.cardQuote.weeklyPrice,79);assert.equal(calls[1].plan,'lite_regular');
  app.requestCardCheckout();assert.deepEqual(app.opened,['https://checkout.example/pay/regular']);
});
