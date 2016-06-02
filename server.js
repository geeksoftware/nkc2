global.__projectroot = __dirname + '/';//create global variable for project root directory
module.paths.push(__projectroot + 'nkc_modules'); //enable require-ment for this path

global.environment = process.env.NODE_ENV?process.env.NODE_ENV:'development';
global.development = environment !== 'production';
console.log('running in '+environment+' mode');

var settings = require('server_settings');
require('helper')();

dash()
report(settings.server.copyright)
if(development)report('server secret is: '+settings.cookie_secret.slice(0,32)+"...")

var moment = require('moment');
var fs = require('fs');
var net = require('net');

var jaderender = require('jaderender');

var compression = require('compression');
var express = require('express');
var rewrite = require('express-urlrewrite');

var cookieparser = require('cookie-parser');

var apifunc = require('api_functions');
var queryfunc = require('query_functions');

queryfunc.db_init();

var nkc = express(); //main router

nkc.set('json spaces',2);
nkc.enable('trust proxy');

//----------------------
//server definitions
var use_https = settings.server.use_https;
//var target_server, redirection_server, tcp_router;

if(use_https){
  var https_options = settings.https_options(); //load the pem files

  var target_server =
  require('https').Server(https_options,nkc);

  var redirection_server =
  require('http').createServer(function(req, res) {
    var host = req.headers['host'];
    res.writeHead(301, { "Location": "https://" + host + req.url });
    res.end();
  });

}else {
  var target_server = require('http').Server(nkc);
}
//-------------------------------

nkc.use(require('serve-favicon')(__dirname+'/resources/site_specific/favicon.ico'));

if(development){
  nkc.use((req,res,next)=>{
    console.log("  -".yellow,req.url);
    //log everything
    next();
  })
}

//1. url rewrite
for(i in settings.urlrewrite){
  nkc.use(rewrite(
    settings.urlrewrite[i].map,
    settings.urlrewrite[i].to
  ));
}

//2. static file serves
for(i in settings.root_serve_static)
{
  var to = settings.root_serve_static[i].to

  if(settings.root_serve_static[i].map){
    var map = settings.root_serve_static[i].map

    nkc.use(map,express.static(to,settings.static_settings))
  } else {
    nkc.use(express.static(to,settings.static_settings));
  }
}

//default avatar redirection
nkc.use(rewrite('/api/avatar/*','/default/default_avatar.gif')) //if avatar not served
nkc.use(rewrite('/api/avatar_small/*','/default/default_avatar_small.gif')) //if avatar not served

nkc.use('/default/',express.static('resources/default_things/',settings.static_settings)) //staticify

//ikc statics serving
nkc.use('/recruit',express.static('../ikc')); //serve company pages

//3. gzip
nkc.use(compression({level:settings.compression_level}));//enable compression

//4. log request, if not static resources
nkc.use((req,res,next)=>{
  //if(req.url.indexOf('/avatar/')>=0&&req.method=='GET')return next();
  //dont record avatar requests

  var d=new Date();
  dash();

  //reformat ipaddr, kill portnames suffix
  req.iptrim = req.ip;
  req.iptrim = req.iptrim.trim().replace( /(:[0-9]{1,})$/ ,''); //kill colon-port
  //req.iptrim = req.ip

  console.log(dateString(d).cyan,
  req.iptrim, req.method, req.originalUrl.cyan);

  next();
});

//5. parse cookie
nkc.use(cookieparser(settings.cookie_secret));

//6. obtain userinfo from cookies
nkc.use((req,res,next)=>{
  var userinfo = req.signedCookies.userinfo;
  if(userinfo){//if not undefined
    req.userinfo = JSON.parse(userinfo);//usually stored in JSON
  }
  next();
});

//7. obtain user (from DB)
nkc.use((req,res,next)=>{
  if(!req.userinfo)return next();//if userinfo (from cookie) not exist
  if(req.url.indexOf('/avatar')>=0 && req.method != 'POST')return next();
  //if going for avatar

  //if userinfo exists
  console.log(JSON.stringify(req.userinfo).gray);

  apifunc.get_user(req.userinfo.uid)
  .then((back)=>{
    if(back.username==req.userinfo.username)
    {
      req.user = back;
    }
  })
  .then(next)
  .catch((err)=>{
    report('error requesting for user',err)
    next() //let go even if error.
  })
});

//8. routes

//api serving
var api_handlers = require('api_handlers.js');
nkc.use('/api',api_handlers.route_handler);

var interface_handlers = require('interface_handlers');
nkc.use('/interface',interface_handlers.route_handler);

// chatroom serving
// WE DONT USE THIS ANYMORE
var chat_handlers = require('chat_handlers.js');
nkc.use('/chat',chat_handlers.route_handler);//routing

// //chatroom socket
// var io = require('socket.io')(target_server);
// //this function must be called after the definition of target_server object.
//
// var chat_io = io.of('/chat');// socket.io namespacing
// chat_handlers.socket_handler(chat_io);//pass namespaced socket object into processing function

//root serving
nkc.get('/',(req,res)=>{
  var data={};
  data.user = req.user;
  data.userinfo = req.userinfo; //from cookies
  data.address = req.ip.toString();
  data.osinfo = JSON.stringify(osinfo(),null,2);
  res.send(
    jaderender('nkc_modules/jade/index.jade',data)
  );
});

if(development){
  //走投无路时，打开第一个锦囊
  nkc.get('/reload',function(req,res){
    res.send(`<h1>Reload Page to Stop Server</h1>`);
    process.exit();
  });
}

//7. error handling
//unrouted url handler
//404 handling
nkc.get('*',(req,res)=>{
  var data = {};
  data.url = req.originalUrl;
  res.status(404).send(
    jaderender('nkc_modules/jade/404.jade',data)
  );
});

//unhandled error handler
//aka 500 handling
nkc.use((err,req,res,next)=>{
  report('not handled',err.stack);
  var data = {};
  data.url = req.originalUrl;
  data.err = err.stack?err.stack:JSON.stringify(err);
  res.status(500).send(
    jaderender('nkc_modules/jade/500.jade',data)
  );
});

//server listening settings
var listenaddr = '0.0.0.0'
if(use_https){
  ///-----start https server-----
  target_server.listen(settings.server.https_port,listenaddr,listenhandle);
  //-----start http redirection server-----
  redirection_server.listen(settings.server.port,listenaddr);
}
else{
  //if not using https
  target_server.listen(settings.server.port,listenaddr,listenhandle);
}

function listenhandle(){
  var listening_addr = target_server.address().address;
  var listening_port = target_server.address().port;
  dash();
  report(settings.server.name+' listening on '+listening_addr+' '+listening_port);
}

//end process after pressing ENTER, for debugging purpose
process.openStdin().addListener('data',function(d){
  if(d.toString().trim()=='')
  process.exit();
});
