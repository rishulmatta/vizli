import {describe,it,expect} from 'vitest';
import {applyObjectEdit,createDemoProject,type ServerMessage} from '@vizli/shared';
import {localResolve,validateProposal,normalizeModelProposal} from './resolver.js';
import {VisualSession} from './session.js';
const project=createDemoProject(),math=project.scenes[1]!;
describe('atomic voice amendments',()=>{
 it('preserves cells and IDs when growing, shrinks safely and never mutates on invalid edits',()=>{
 const grown=applyObjectEdit(math,'matrix-a',{matrix:{rows:3,cols:2},cell:{row:2,col:1,value:9}});
 expect(grown.objects.find(o=>o.id==='matrix-a')!.cells).toEqual([[1,2],[3,4],[0,9]]);
 expect(applyObjectEdit(grown,'matrix-a',{matrix:{rows:1,cols:1}}).objects.find(o=>o.id==='matrix-a')!.cells).toEqual([[1]]);
 expect(()=>applyObjectEdit(math,'matrix-a',{label:'changed',cell:{row:4,col:0,value:9}})).toThrow();
 expect(math.objects.find(o=>o.id==='matrix-a')!.cells).toEqual([[1,2],[3,4]]);
 expect(()=>applyObjectEdit(math,'matrix-a',{matrix:{rows:31}})).toThrow();
 });
 it('edits text, metric, color and existing chart data with kind and bounds checks',()=>{
 const scene=applyObjectEdit(project.scenes[0]!,'revenue',{value:'$4.5M',label:'New revenue',color:'#ff0000',width:300});
 expect(scene.objects.find(o=>o.id==='revenue')).toMatchObject({value:'$4.5M',color:'#ff0000',width:300});
 expect(applyObjectEdit(scene,'channels',{chartDatum:{index:2,value:95}}).objects.find(o=>o.id==='channels')!.data).toEqual([42,68,95,57]);
 expect(()=>applyObjectEdit(scene,'channels',{value:'no'})).toThrow();expect(()=>applyObjectEdit(scene,'channels',{chartDatum:{index:99,value:0}})).toThrow();expect(()=>applyObjectEdit(scene,'revenue',{width:2401})).toThrow();
 });
 it('resolves spoken dimensions and one-based cells, rejects ambiguous and invalid targets',()=>{
 const resolve=(text:string)=>localResolve({text,scene:math,cues:[]});
 expect(resolve('Make matrix A three by two')).toMatchObject({type:'edit_object',targetId:'matrix-a',patch:{matrix:{rows:3,cols:2}}});
 expect(resolve('Set row two column one of matrix A to minus five')).toMatchObject({type:'edit_object',patch:{cell:{row:1,col:0,value:-5}}});
 expect(resolve('Make matrix three by two').type).toBe('skip');expect(resolve('Set row nine column one of matrix A to five').type).toBe('skip');
 });
 it('grounds model edits and normalizes null properties without accepting invented dimensions',()=>{
 const proposal={type:'edit_object' as const,targetId:'matrix-a',patch:{matrix:{rows:3,cols:2}},reason:'Requested'};
 expect(validateProposal(proposal,math,'make matrix 3 by 2').type).toBe('skip');expect(validateProposal(proposal,math,'resize matrix A').type).toBe('skip');
 expect(validateProposal(proposal,math,'make matrix A 3 by 2').type).toBe('edit_object');
 expect(normalizeModelProposal({patch:{label:null,matrix:{rows:3,cols:null},cell:null}})).toEqual({patch:{matrix:{rows:3}}});
 });
 it('rejects edit intent disguised as attention and removes echoed no-op properties',()=>{
 const scene=project.scenes[0]!,revenue=scene.objects.find(o=>o.id==='revenue')!;
 expect(validateProposal({type:'edit_object',targetId:'revenue',reason:'Requested',patch:{value:'$4.5M',width:revenue.width,height:revenue.height,color:revenue.color}},scene,'Change Revenue to $4.5M')).toMatchObject({type:'edit_object',patch:{value:'$4.5M'}});
 expect(validateProposal({type:'edit_object',targetId:'takeaway',reason:'Requested',patch:{text:'Revenue grew'}},scene,'Change takeaway text to Revenue grew')).toMatchObject({type:'edit_object',patch:{text:'Revenue grew'}});
 expect(validateProposal({type:'highlight',targetId:'matrix-a',reason:'Requested'},math,'Set row three').type).toBe('skip');
 const grown=applyObjectEdit(math,'matrix-a',{matrix:{rows:3,cols:2}});
 expect(localResolve({text:'Change the cell in the 3rd row and 2nd column of matrix A to nine',scene:grown,cues:[]})).toMatchObject({type:'edit_object',patch:{cell:{row:2,col:1,value:9}}});
 expect(validateProposal({type:'edit_object',targetId:'matrix-a:cell:2:1',reason:'Requested',patch:{cell:{row:2,col:1,value:9}}},grown,'Change third row second column of matrix A to nine')).toMatchObject({type:'edit_object',targetId:'matrix-a'});
 });
 it('only dispatches persistent edits on finals and fences stale results',async()=>{
 const messages:ServerMessage[]=[];const s=new VisualSession(m=>messages.push(m));s.setScene(math,1,[]);
 await s.cue('Make matrix A three by two',false,true);expect(messages.some(m=>m.type==='action')).toBe(false);
 await s.cue('Make matrix A three by two',true,true);expect(messages.find(m=>m.type==='action')).toMatchObject({action:{type:'edit_object',patch:{matrix:{rows:3,cols:2}}}});s.close();
 let finish!:(value:any)=>void;const delayed=new VisualSession(m=>messages.push(m),()=>new Promise(resolve=>{finish=resolve}));delayed.setScene(math,1,[]);const task=delayed.cue('resize matrix A',true,true);delayed.setScene(math,2,[]);finish({type:'edit_object',targetId:'matrix-a',patch:{matrix:{rows:3}},reason:'Requested'});await task;expect(messages.filter(m=>m.type==='action')).toHaveLength(1);delayed.close();
 });
});
