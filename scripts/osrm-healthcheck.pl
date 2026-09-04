#!/usr/bin/perl
#
# Healthcheck for osrm-routed: asks for a real route and checks the answer.
#
# In a FILE rather than inline in docker-compose.yml, for the same reason
# scripts/postgis-healthcheck.sh is (D8): the equivalent CMD-SHELL string needs
# nested quoting that is unreadable and easy to break.
#
# In PERL because `osrm/osrm-backend:v5.25.0` ships neither curl nor wget — the
# previous curl-based healthcheck exited 127 ("curl: not found") on every run,
# so both OSRM services had reported `unhealthy` since the day they were added
# while answering routes perfectly. Nothing depended on them, so nothing caught
# it. Perl is in the image and IO::Socket::INET is core, so this needs no
# install layer.
#
# A real route, not a port probe: osrm-routed accepts connections before the
# graph is usable, and a port check would call a half-loaded graph healthy.
# The coordinates are two points a couple of kilometres apart in Patna, which
# every build of this extract contains.
use strict;
use warnings;
use IO::Socket::INET;

my $port = $ENV{OSRM_HEALTHCHECK_PORT} || 5000;
my $path = '/route/v1/driving/85.13,25.59;85.14,25.60?overview=false';

my $socket = IO::Socket::INET->new(
    PeerAddr => '127.0.0.1',
    PeerPort => $port,
    Proto    => 'tcp',
    Timeout  => 5,
) or exit 1;

print $socket "GET $path HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";

# Bounded read: a wedged server that accepts the connection and then says
# nothing must fail the check rather than hang it until Docker's own timeout.
my $deadline = time + 5;
my $response = '';

while ( time < $deadline ) {
    my $chunk;
    my $bytes = sysread( $socket, $chunk, 4096 );
    last if !defined $bytes || $bytes == 0;
    $response .= $chunk;
    last if length($response) > 65536;
}

close $socket;

# `code: Ok` is the only success. `NoRoute` means the graph loaded but does not
# contain these points, which is a broken artifact, not a healthy service.
exit( $response =~ /"code"\s*:\s*"Ok"/ ? 0 : 1 );
