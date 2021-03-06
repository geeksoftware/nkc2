

var moment = require('moment')
var path = require('path')
var fs = require('fs.extra')
var settings = require('../server_settings.js');
var helper_mod = require('../helper.js')();
var queryfunc = require('../query_functions')
var AQL = queryfunc.AQL
const db = queryfunc.getDB();
const aql = queryfunc.getAql();
const im = require('../im_functions');
const operationScoreHandler = require('../score_handler').operationScoreHandler;

var layer = require('../layer')

var table = {};
module.exports = table;

table.moveThread = {
  operation:function(params){
    //check if fid exists
    var po = params.permittedOperations
    var fid = params.fid
    var tid = params.tid
    var cid = params.cid
    const user = params.user;
    var thread = new layer.Thread(tid)
    var destforum = new layer.Forum(fid)
    var origforum

    return thread.load()
    .then(thread=>{
      if(thread.model.fid) {
        origforum = new layer.Forum(thread.model.fid)
        return origforum.load()
          .then(origforum => {
            return origforum.inheritPropertyFromParent()
          })
          .then(origforum => {
            if (po['moveAllThreads']) {
              return
            }
            //else we have to check: do you own the original forum?
            return origforum.testModerator(params.user._key)
          })
      }
      db.query(aql`
        LET pf = DOCUMENT(personalForums, ${thread.mid})
        RETURN pf.moderators
      `)
        .then(cursor => cursor.all())
        .then(moderators => {
          if(moderators.indexOf(user.username) === -1) throw '权限不足'
        })
    })
    .then(()=>{
      return destforum.load()
    })
    .then(destforum=>{
      //test existence
      return thread.update({fid,cid})
    })
    .then(() => {
      if(fid === 'recycle')
        return operationScoreHandler({
          address: params._req.iptrim,
          port: params._req.connection.remotePort,
          isManageOp: true,
          operation: 'moveToRecycle',
          from: params.user._key,
          to: thread.model.uid,
          timeStamp: Date.now(),
          parameters: {
            targetKey: 't/' + thread.model._key
          }
        })
    })
    .then(()=>`successfully moved ${tid} to ${fid}`)
  },
  requiredParams:{
    tid:String,
    fid:String,
  },
  testPermission:function(params){
    //get original fid of given tid, and check if user is moderator to fid.
    //if(getThread(params.tid).owner.indexOf(params.user)<0) return Promise.reject('you cant move that')

    return 0;
  },
}

table.disablePost = {
  operation:function(params){
    var pid = params.pid
    var post = new layer.Post(pid)
    var po = params.permittedOperations
    let thread;
    let origforum;
    return post.load()
    .then(post=>{
      return post.loadForum()
    })
    .then(of=> {
      origforum = of;
      thread = new layer.Thread(post.model.tid);
      return thread.load()
    })
    .then(() => {
      let model = thread.model;
      if(!model.fid && model.toMid === params.user._key || !model.fid && !model.toMid && model.mid === params.user._key) {
        return
      }
      if (po['toggleAllPosts']) {
        return
      }
      //else we have to check: do you own the original forum?
      return origforum.testModerator(params.user._key)
    })
    .then(() => operationScoreHandler({
      address: params._req.iptrim,
      port: params._req.connection.remotePort,
      isManageOp: true,
      operation: 'disablePost',
      from: params.user._key,
      to: post.model.uid,
      timeStamp: Date.now(),
      parameters: {
        targetKey: 't/' + thread.model._key,
        pid
      }
    }))
    .then(()=>{
      return post.update({disabled:true})
      .then(post=>{
        var op = require('../api_operations.js')
        return op.table.updateThread.operation({tid:post.model.tid})
        .then(()=>{
          return 'success'
        })
      })
    })
  },
  requiredParams:{
    pid:String,
  },
  testPermission:function(params){
    return 0;
  },
}

table.enablePost = {
  operation:function(params){
    var pid = params.pid
    var post = new layer.Post(pid)
    var po = params.permittedOperations

    return post.load()
    .then(post=>{
      return post.loadForum()
    })
    .then(origforum=>{
      if(po['toggleAllPosts']){
        return
      }
      //else we have to check: do you own the original forum?
      return origforum.testModerator(params.user._key)
    })
    .then(()=>{
      return post.update({disabled:null})
    })
      .then(post => {
        var op = require('../api_operations.js');
        return op.table.updateThread.operation({tid: post.model.tid})
      })
  },
  requiredParams:{
    pid:String,
  },
  testPermission:function(params){
    return 0;
  },
}

table.addThreadToCart={
  operation:function(params){
    var uid = params.user._key
    var tid = params.tid.toString()
    return AQL(`
      let u = document(users,@uid)
      update u with { cart:SLICE(UNIQUE(PUSH(u.cart,@cid)),-30) } in users
      `,{
        uid:uid,
        cid:'threads/'+tid,
      }
    )
  },
  requiredParams:{
    tid:String,
  }
}

table.addPostToCart={
  operation:function(params){
    var uid = params.user._key
    var pid = params.pid.toString()
    return AQL(`
      let u = document(users,@uid)
      update u with { cart:SLICE(UNIQUE(PUSH(u.cart,@cid)),-30) } in users
      `,{
        uid:uid,
        cid:'posts/'+pid,
      }
    )
  },
  requiredParams:{
    pid:String,
  }
}

table.listCart={
  operation:function(params){
    var cart = params.user.cart?params.user.cart:[];
    return AQL(
      `
      for i in @cart
      let c = document(i)
      filter c != null
      let oc = document(posts,c.oc)
      return merge(c,{oc})
      `
      ,{
        cart,
      }
    )
  },
}

table.clearCart={
  operation:function(params){
    var uid = params.user._key
    return queryfunc.doc_update(uid,'users',{cart:[]})
  }
}

table.setDigest={
  operation:function(params){
    let forum;
    var tid = params.tid
    var thread = new layer.Thread(tid)
    var po = params.permittedOperations

    return thread.load()
    .then(thread=>{
      return thread.loadForum()
    })
    .then(origforum=>{
      forum = origforum;
      if(po['toggleDigestAllThreads']){
        return
      }

      //else we have to check: do you own the original forum?
      return origforum.testModerator(params.user._key)
    })
    .then(()=>{
      return thread.update({digest:thread.model.digest?null:true})
    })
    .then(() => {
      const timeStamp = Date.now();
      if(thread.model.digest)
        return operationScoreHandler({
          address: params._req.iptrim,
          port: params._req.connection.remotePort,
          isManageOp: true,
          operation: 'setDigest',
          from: params.user._key,
          to: thread.model.uid,
          timeStamp,
          parameters: {
            targetKey: 't/' + tid
          }
        });
      return operationScoreHandler({
        address: params._req.iptrim,
        port: params._req.connection.remotePort,
        isManageOp: true,
        operation: 'cancelDigest',
        from: params.user._key,
        to: thread.model.uid,
        timeStamp,
        parameters: {
          targetKey: 't/' + tid
        }
      })
    })
    .then(() => {
      if(!forum.model) return
      return queryfunc.setDigestHook(forum.model._key, thread.model.digest)
    })
    .then(()=>{
      return {message:thread.model.digest?'设置精华':'撤销精华'}
    })
  },
  requiredParams:{
    tid:String,
  }
}

table.setTopped={
  operation:function(params){
    var tid = params.tid
    var thread = new layer.Thread(tid)
    var po = params.permittedOperations

    return thread.load()
    .then(thread=>{
      return thread.loadForum()
    })
    .then(origforum=>{
      if(po['toggleToppedAllThreads']){
        return
      }

      //else we have to check: do you own the original forum?
      return origforum.testModerator(params.user._key)
    })
    .then(()=>{
      return thread.update({topped:thread.model.topped?null:true})
    })
    .then(() => {
      const timeStamp = Date.now();
      if(thread.model.topped)
        return operationScoreHandler({
          address: params._req.iptrim,
          port: params._req.connection.remotePort,
          isManageOp: true,
          operation: 'cancelTopped',
          from: params.user._key,
          to: thread.model.uid,
          timeStamp,
          parameters: {
            targetKey: 't/' + tid
          }
        });
      return operationScoreHandler({
        address: params._req.iptrim,
        port: params._req.connection.remotePort,
        isManageOp: true,
        operation: 'setTopped',
        from: params.user._key,
        to: thread.model.uid,
        timeStamp,
        parameters: {
          targetKey: 't/' + tid
        }
      });
    })
    .then(()=>{
      return {message:thread.model.topped?'设为置顶':'撤销置顶'}
    })
  },
  requiredParams:{
    tid:String,
  }
}

table.pullNewPosts24h = {
  operation:function(params){
    return AQL(`for p in posts
      filter p.toc> date_now()-86400000
      sort p.toc desc
      return p`
    )
  }
}

table.unbanUser = {
  operation:function(params) {
    var u = new layer.User(params.uid)
    return u.load()
      .then(u=>{
        var certs = (u.model.certs||[])
        certs = certs.filter(c=>c!='banned')
        return u.update({certs})
      })
      .then(() => 'success')
  },
  requiredParams:{
    uid:String,
  }
}

table.banUser = {
  operation:function(params){
    var u = new layer.User(params.uid)
    return u.load()
      .then(u=>{
        var certs = (u.model.certs||[])

        if(
          certs.indexOf('moderator')>=0||
          certs.indexOf('editor')>=0||
          certs.indexOf('dev')>=0||
          certs.indexOf('scholar')>=0||

          u.model.xsf>0
        ){
          throw '为什么？你为何要封禁此用户？你是怎么了？'
        }

        if(certs.indexOf('banned')>=0){
          throw '这人被封过了吧。。。刷新试试'
        }

        certs = certs.concat(['banned'])

        return u.update({certs})
      })
      .then(u=>{
        return db.collection('activeusers').all()
          .then(cursor => cursor.all())
          .then(result => {
            for(let user of result) {
              if(user.uid === u.model._key) {
                return true
              }
            }
            return false
          })
      })
      .then(flag => {
        if(flag) return queryfunc.rebuildActiveUsers();
      })
      .then(message => 'success' + message)
  },
  requiredParams:{
    uid:String,
  }
}

table.addCredit = {
  operation:function(params){
    //0. extract params
    var q = Number(params.q)
    if(q>10000 ||q<-10000){
      throw 'invalid q va lue'
    }

    var type = params.type
    var pid = params.pid



    var reason = params.reason
    if(reason.length<2)throw '写太短啦'

    if(typeof(reason)!='string')throw 'bad reason'

    //1. tell type

    switch (type) {
      case 'xsf':
      case 'kcb':
      break;

      default:
      throw 'credit type not recognized'
    }

    //3. give to targetuser
    return AQL(`
      let p = document(posts,@pid)
      let u = document(users,p.uid)
      update u with {@type:(@q+u.@type)} in users
      return NEW
      `,{pid,type,q}
    )
    .then(arr=>{
      var touid = arr[0]._key;

      //2. make new
      var cl = new layer.BaseDao('creditlogs')
      return cl.save({
        pid,
        type,
        q,
        uid:params.user._key,
        username:params.user.username,
        address: params._req.connection.remoteAddress,
        port: params._req.connection.remotePort,
        touid,
        reason,
        source:'nkc',
        toc:Date.now(),
      })
      .then(cl=>{
        var operations = require('../api_operations.js')
        return operations.table.updatePost.operation(params)
      })
      .then(()=>{
        return arr[0]
      })
    })
  },
  requiredParams:{
    pid:String,
    reason:String,
    type:String,
    q:Number,
  }
};

table.forumVisibilitySwitch = {
  operation: params => {
    var forum = new layer.Forum(params.fid);
    return forum.visibilitySwitch()
      .then(res => {
        return res._result[0];
      });
  }
};

table.forumIsVisibleForNCCSwitch = {
  operation: params => {
    var forum = new layer.Forum(params.fid);
    return forum.isVisibleForNCCSwitch()
      .then(res => res._result[0]);
  }
};

table.moveToPersonalForum = {
  operation: params => {
    if('moveToPersonalForum' in params.permittedOperations) {
      return db.collection('threads').document(params.tid)
        .then(t => {
          if(!t.fid || !t.mid) throw '操作有误,请报告论坛';
          return db.collection('threads').update(t, {fid: null})
        })
        .catch(e => {throw e})
    }
    throw `权限不足`
  }
};

table.switchVInPersonalForum = {
  operation: params => {
    const po = params.permittedOperations;
    const tid = params.tid;
    const user = params.user;
    let thread;
    let myForum;
    let othersForum;
    if('switchVInPersonalForum' in po) {
      return db.collection('threads').document(tid)
        .then(t => {
          thread = t;
          return db.collection('personalForums').document(thread.mid)
        })
        .then(mf => {
          myForum = mf;
          if(thread.toMid) return db.collection('personalForums').document(thread.toMid)
        })
        .then(oF => {
          if(oF) othersForum = oF;
          return true
        })
        .then(() => {
          if(
            thread.toMid === user._key ||
            othersForum && othersForum.moderators.indexOf(user._key) > -1
          ) {
            return db.collection('threads').update(thread, {hideInToMid: !thread.hideInToMid})
              .catch(e => {throw e})
          }
          else if(
            thread.mid === user._key ||
            myForum.moderators.indexOf(user._key) > -1
          ) {
            return db.collection('threads').update(thread, {hideInMid: !thread.hideInMid})
              .catch(e => {throw e});
          }
          throw '操作有误,请报告论坛' + thread.mid
        })
    }
    throw '权限不足'
  }
};

table.switchDInPersonalForum = {
  operation: params => {
    const po = params.permittedOperations;
    const tid = params.tid;
    const user = params.user;
    let thread;
    let myForum;
    let othersForum;
    if('switchDInPersonalForum' in po) {
      return db.collection('threads').document(tid)
        .then(t => {
          thread = t;
          return db.collection('personalForums').document(thread.mid)
        })
        .then(mf => {
          myForum = mf;
          if(thread.toMid) return db.collection('personalForums').document(thread.toMid)
        })
        .then(oF => {
          if(oF) othersForum = oF;
          return true
        })
        .then(() => {
          if(
            thread.toMid === user._key ||
            othersForum && othersForum.moderators.indexOf(user._key) > -1
          ) {
            return db.collection('threads').update(thread, {digestInToMid: !thread.digestInToMid})
              .catch(e => {throw e})
          }
          else if(
            thread.mid === user._key ||
            myForum.moderators.indexOf(user._key) > -1
          ) {
            return db.collection('threads').update(thread, {digestInMid: !thread.digestInMid})
              .catch(e => {throw e});
          }
          throw '操作有误,请报告论坛' + t.mid
        })
    }
    throw '权限不足'
  }
};

table.popPFSwitch = {
  operation: params => {
    const pfID = params.pfID;
    return db.collection('settings').document('system')
      .then(settings => {
        const popPersonalForums = settings.popPersonalForums;
        const index = popPersonalForums.findIndex((elem, i, arr) => elem === pfID);
        if(index > -1) {
          popPersonalForums.splice(index, 1);
          return popPersonalForums
        }
        if(popPersonalForums.length === 8)
          popPersonalForums.shift();
        popPersonalForums.push(pfID);
        return popPersonalForums
      })
      .then(arr => db.collection('settings').update('system', {popPersonalForums: arr}))
  }
};

table.pushSysInfo = {
  operation: params => {
    const info = params.info;
    return db.collection('sms').save({
      c: info,

    })
  }
};

table.adSwitch = {
  operation: params => {
    const tid = params.tid;
    return db.collection('settings').document('system')
      .then(settings => {
        const ads = settings.ads;
        const index = ads.findIndex((elem, i, arr) => elem === tid);
        if(index > -1) {
          ads.splice(index, 1);
          return im.removeFile(`./resources/ad_posts/${tid}.jpg`)
            .then(() => ads)
        }
        if(ads.length === 6)
          ads.shift();
        ads.push(tid);
        return db.query(aql`
            LET thread = DOCUMENT(threads, ${tid})
            LET post = DOCUMENT(posts, thread.oc)
            LET rs = post.r || []
            LET resources = (
              FOR r IN rs
                LET resource = DOCUMENT(resources, r)
                FILTER POSITION(['jpg', 'png', 'svg', 'jpeg'], resource.ext, false)
                return resource
            )
            RETURN resources[0]
          `)
          .then(cursor => cursor.next())
          .then(resource => {
            if(resource) {
              const name = './resources/ad_posts/' + tid + '.jpg';
              const path = './resources/upload' + resource.path;
              return im.generateAdPost(path, name)
            }
            return db.query(aql`
                LET thread = DOCUMENT(threads, ${tid})
                LET user = DOCUMENT(users, thread.uid)
                RETURN user._key
              `)
              .then(cursor => cursor.next())
              .then(uid => {
                let path = './resources/newavatar/' + uid + '.jpg';
                const name = './resources/ad_posts/' + tid + '.jpg';
                return im.generateAdPost(path, name)
              })
          })
          .then(() => ads)
      })
      .then(arr => db.collection('settings').update('system', {ads: arr}))
  }
};
