#define _DARWIN_C_SOURCE
#include <stdio.h>
#include <unistd.h>
#include <signal.h>
#include <string.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <sys/time.h>
#include "../../../native/main-installation/wire.h"
#include "installed-main-client.h"
#include "../../../native/broker-authority-source/broker-child-launch.h"
#if !defined(MI_FIXTURE_BUILD) || !defined(NR_ROOT_IO_COMPONENT)
#error "Fixed component realm only"
#endif
static int actual_http(int port,const char *route,int expected){
 int fd=socket(AF_INET,SOCK_STREAM,0);if(fd<0)return 0;
 struct timeval timeout={2,0};int good=!setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
 struct sockaddr_in address={0};address.sin_family=AF_INET;address.sin_port=htons((unsigned short)port);address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
 if(good)good=!connect(fd,(struct sockaddr*)&address,sizeof(address));
 char request[256],response[32768]={0};int length=snprintf(request,sizeof(request),"GET %s HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",route);size_t used=0;
 if(good)good=send(fd,request,(size_t)length,0)==length;
 while(good&&used<sizeof(response)-1){ssize_t n=read(fd,response+used,sizeof(response)-used-1);if(!n)break;if(n<0){good=0;break;}used+=(size_t)n;}
 char status[32];snprintf(status,sizeof(status),"HTTP/1.1 %d",expected);if(good)good=used&&strstr(response,status)==response;
 if(good&&expected==200)good=strstr(response,"entryHash")&&strstr(response,"intent-broker");
 if(close(fd))good=0;return good;
}
int main(void){
 nm_installed_client *client=nm_installed_create();nr_root_store_io *io=NULL;
 const nr_root_bootstrap_claim *claim=NULL;nr_root_store_identity identity;
 nm_broker_child_birth *birth=NULL,*duplicate=NULL;nm_installed_fate before={0},after={0},fate={0};
 int failure=0,once=0,held=0,cancelled=0;
 if(!client||!nm_installed_connect(client)||!nr_component_borrow_original_root_store(client,&io)||!nr_root_store_read_identity(io,&identity)){failure=1;goto cleanup;}
 if(identity.birth_state==NR_CREATED){if(!nr_root_store_claim_fresh(io,&claim)||!nr_root_store_read_claim(io,claim,&identity)||!nr_root_store_bind_bootstrap(io,NR_FRESH_COMMIT,claim,&identity)){failure=2;goto cleanup;}}
 else if(identity.birth_state!=NR_BOUND){failure=2;goto cleanup;}
 char pool[65]={0};for(int index=0;index<32;index++)snprintf(pool+2*index,3,"%02x",identity.pool_id[index]);
 printf("{\"kind\":\"broker-native-original-pool\",\"poolId\":\"%s\",\"fresh\":%s}\n",pool,claim?"true":"false");
 if(!nm_installed_prepare_core_broker_child(client,&birth)||!birth){failure=3;goto cleanup;}
 if(!nm_installed_fate_read(client,&before)){failure=4;goto cleanup;}
 once=!nm_installed_prepare_core_broker_child(client,&duplicate)&&!duplicate&&nm_installed_fate_read(client,&after)&&before.root_sequence==after.root_sequence;
 if(!once){failure=5;goto cleanup;}
 #ifdef MI_FIXTURE_BROKER_RUN_CHILD
 if(!nm_broker_child_launch(birth)){failure=11;goto cleanup;}
 const char *scenario=__BOOTSTRAP_SCENARIO__;
 const char *frame=!strcmp(scenario,"wrong-config")?
  "{\"kind\":\"original_broker_start_v1\",\"environment\":{\"authority\":\"forbidden\"}}\n":
  "{\"kind\":\"original_broker_start_v1\",\"environment\":{\"XIAOK_CONFIG_DIR\":\"" MI_FIXED_ROOT "/config\",\"PORT\":\"0\",\"INTENT_BROKER_DB\":\"" MI_FIXED_ROOT "/diagnostic.sqlite\",\"INTENT_BROKER_SOCKET_PATH\":\"\",\"INTENT_BROKER_DESKTOP_TOKEN\":\"private-test-desktop\",\"INTENT_BROKER_KSWARM_TOKEN\":\"private-test-kswarm\"}}\n";
 if(strcmp(scenario,"early-close")){
  uint32_t sent=0;size_t total=strlen(frame);while(sent<total){uint32_t actual=0;if(!nm_broker_child_write_business(birth,frame+sent,(uint32_t)(total-sent),&actual)){failure=18;goto cleanup;}sent+=actual;if(!actual)usleep(1000);}
 }
 held=!nm_installed_close_owned(client);if(!held){failure=6;goto cleanup;}
 int signalled=0,ready=0,http=0;char frames[8192]={0};size_t frame_size=0;
 unsigned char bytes[4096];int done=0;uint64_t deadline=mi_now_ms()+15000;
 while(!done&&mi_now_ms()<deadline){
  int exited=nm_broker_child_poll_owned(birth),closed=0;if(exited<0){failure=14;goto cleanup;}
  for(int stream=1;stream<=3;stream++)for(;;){uint32_t count=0;int code=nm_broker_child_read_stream(birth,stream,bytes,sizeof(bytes),&count);if(code<0){failure=15;goto cleanup;}if(code==0){closed++;break;}if(code==2)break;if(stream<=2&&write(stream,bytes,count)!=(ssize_t)count){failure=16;goto cleanup;}
   if(stream==3){
    if(frame_size+count>=sizeof(frames)){failure=19;goto cleanup;}memcpy(frames+frame_size,bytes,count);frame_size+=count;frames[frame_size]=0;
    if(strstr(frames,"original_broker_ready_v1"))ready=1;
    if(!signalled&&((!strcmp(scenario,"normal")&&ready)||(!strcmp(scenario,"early-close")&&strstr(frames,"original_broker_waiting_v1")))){if(ready){const char *field=strstr(frames,"\"port\":");int port=field?atoi(field+7):0;if(port<1||port>65535||!actual_http(port,"/health",200)||!actual_http(port,"/rooms",401)){failure=22;goto cleanup;}http=1;}
     if(!nm_broker_child_signal_owned(birth,SIGTERM)){failure=20;goto cleanup;}signalled=1;}
   }}
  if(exited&&closed==3)done=1;else usleep(1000);
 }
 if(!done){failure=17;goto cleanup;}
 if((!strcmp(scenario,"normal")&&!ready)||(!strcmp(scenario,"early-close")&&ready)){failure=21;goto cleanup;}
 printf("{\"kind\":\"broker-bootstrap-parent\",\"ready\":%s,\"http\":%s,\"signalled\":%s,\"productionQualified\":false}\n",ready?"true":"false",http?"true":"false",signalled?"true":"false");
 cancelled=nm_broker_child_wait_owned(birth);
#ifdef MI_FIXTURE_BROKER_SKIP_CLOSE
 int missing_pid=0,missing_status=0,missing_known=1;
 int read=nm_broker_child_read_fate(birth,&missing_pid,&missing_status,&missing_known);
 int terminal_rejected=!nm_broker_child_assert_terminal(birth),root_held=!nm_installed_close_owned(client);
 printf("{\"kind\":\"broker-missing-close-rejected\",\"waitRejected\":%s,\"childExitStatus\":%d,\"childPid\":%d,\"physicalKnown\":%s,\"terminalRejected\":%s,\"rootCloseHeld\":%s,\"productionQualified\":false}\n",cancelled?"false":"true",missing_status,missing_pid,missing_known?"true":"false",terminal_rejected?"true":"false",root_held?"true":"false");
 nm_installed_release(client);return !cancelled&&read&&missing_pid>0&&!missing_status&&!missing_known&&terminal_rejected&&root_held?0:1;
#else
 if(!cancelled){failure=12;goto cleanup;}
#endif
 int actual_pid=0,wait_status=0,physical_known=0;
 if(!nm_broker_child_read_fate(birth,&actual_pid,&wait_status,&physical_known)||!physical_known||wait_status){failure=13;goto cleanup;}
 printf("{\"kind\":\"broker-native-original-wait\",\"pid\":%d,\"status\":%d,\"known\":true}\n",actual_pid,wait_status);
#else
 held=!nm_installed_close_owned(client);if(!held){failure=6;goto cleanup;}
 cancelled=nm_broker_child_cancel_unlaunched(birth)&&nm_broker_child_cancel_unlaunched(birth);
 if(!cancelled){failure=7;goto cleanup;}
#endif
cleanup:
 if(io&&nr_root_store_release_owned(io)!=NR_SQL_FILES_CLOSED&&!failure)failure=8;
 if(client&&!nm_installed_close_owned(client)&&!failure)failure=9;
 if(client&&!nm_installed_fate_read(client,&fate)&&!failure)failure=10;
 printf("{\"kind\":\"broker-fixed-native-core-component\",\"failure\":%d,\"onceZeroIo\":%s,\"coreCloseHeld\":%s,\"negativeCleanupKnown\":%s,\"rootFilesClosed\":%s,\"unknown\":%s,\"productionQualified\":false}\n",failure,once?"true":"false",held?"true":"false",cancelled?"true":"false",fate.root_files_closed?"true":"false",fate.unknown?"true":"false");
 nm_installed_release(client);return failure?1:0;
}
