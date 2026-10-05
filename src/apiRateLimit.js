const { ApiError } = require('./apiError');

class ApiRateLimiter {
  constructor({clock=Date.now,requests=600,writes=60,windowMs=60000,maxClients=10000} = {}) {
    this.clock=clock;
    this.requests=requests;
    this.writes=writes;
    this.windowMs=windowMs;
    this.maxClients=maxClients;
    this.clients=new Map();
  }

  check(req) {
    const now=this.clock();
    const key=req.socket?.remoteAddress || 'unknown';
    let state=this.clients.get(key);
    if (!state || now>=state.expiresAt) {
      if (this.clients.size>=this.maxClients) {
        for (const [ip,value] of this.clients) if (now>=value.expiresAt) this.clients.delete(ip);
        if (!this.clients.has(key) && this.clients.size>=this.maxClients) throw new ApiError(429,'Too many API clients; try again later');
      }
      state={requests:0,writes:0,expiresAt:now+this.windowMs};
    }
    const writing=!['GET','HEAD'].includes(req.method);
    if (state.requests>=this.requests || (writing && state.writes>=this.writes)) throw new ApiError(429,'Too many requests; try again later');
    this.clients.set(key,{...state,requests:state.requests+1,writes:state.writes+(writing ? 1 : 0)});
  }
}

module.exports={ApiRateLimiter};
